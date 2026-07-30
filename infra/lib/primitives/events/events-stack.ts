import { Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'

/** Name of the platform custom event bus (EXECUTION.md §3 M0 item 3). */
export const PLATFORM_BUS_NAME = 'platform-bus'

/** SSM parameter paths published by this stack (cross-stack refs go via SSM only). */
export const EVENTS_SSM_PATHS = {
  busName: '/platform/events/bus-name',
  busArn: '/platform/events/bus-arn',
  auditBucketName: '/platform/events/audit-bucket-name'
} as const

/**
 * Object Lock default retention for the audit trail.
 *
 * GOVERNANCE (not COMPLIANCE) on purpose: it still makes audit objects
 * immutable to every principal and workload (including the agents), but a
 * break-glass admin holding `s3:BypassGovernanceRetention` can recover from
 * operator error — e.g. a misconfigured Firehose flooding the bucket with
 * junk, or PII landing in an event payload that must legally be deleted.
 * COMPLIANCE mode would make such objects undeletable by anyone (account
 * root included) for the full retention period, which is an unacceptable
 * one-way door for a single-account startup. Revisit at the multi-account /
 * compliance-customer trigger in EXECUTION.md §2.
 */
const AUDIT_RETENTION = Duration.days(365)

/** Firehose buffering: audit events land in S3 within ~60s or 5 MiB, whichever first. */
const FIREHOSE_BUFFER_INTERVAL = Duration.seconds(60)
const FIREHOSE_BUFFER_SIZE = Size.mebibytes(5)

/** Hive-style date partitioning so Athena can query the trail cheaply. */
const AUDIT_PREFIX = 'audit/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/'
const AUDIT_ERROR_PREFIX =
  'audit-errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/'

/** Lifecycle: recent audit data stays hot, then tiers down. Never expires. */
const TRANSITION_TO_IA_AFTER = Duration.days(30)
const TRANSITION_TO_GLACIER_AFTER = Duration.days(180)

/** Server-access logs are operational, not audit data — expire them. */
const ACCESS_LOG_EXPIRY = Duration.days(90)

export interface EventsStackProps extends StackProps {}

/**
 * Platform event bus + audit trail (EXECUTION.md §3 M0 item 3).
 *
 * - `platform-bus`: the custom EventBridge bus every platform event flows
 *   through (published via `@platform/events`, envelope per
 *   `contracts/events/envelope.schema.json`).
 * - EventBridge Archive with indefinite retention: the replay mechanism
 *   (EXECUTION.md §2 — "EventBridge + archive/replay only"; Kinesis is a
 *   later upgrade trigger).
 * - Catch-all rule → Firehose → S3: the immutable audit trail. Every event,
 *   no exceptions — M4's "show the audit trail proving it" depends on this
 *   being complete.
 *
 * Audit bucket: versioned, S3-managed encryption, Object Lock in GOVERNANCE
 * mode with a 1-year default retention (see `AUDIT_RETENTION` for the mode
 * rationale), all public access blocked, lifecycle tiering to IA/Glacier.
 * CDK note: Object Lock requires `objectLockEnabled: true` together with
 * `versioned: true`; CloudFormation only supports enabling Object Lock at
 * bucket creation, so this must never be retrofitted onto an existing bucket.
 */
export class EventsStack extends Stack {
  /** The platform custom event bus. */
  public readonly bus: events.EventBus
  /** Immutable audit-trail bucket (Object Lock, GOVERNANCE). */
  public readonly auditBucket: s3.Bucket
  /** Firehose delivery stream writing the audit trail. */
  public readonly auditDeliveryStream: firehose.DeliveryStream

  constructor(scope: Construct, id: string, props?: EventsStackProps) {
    super(scope, id, props)

    this.bus = new events.EventBus(this, 'PlatformBus', {
      eventBusName: PLATFORM_BUS_NAME,
      description: 'Platform event bus — every venture and platform event flows through here.'
    })

    // Replay mechanism: retain every event indefinitely (no `retention` = never expire).
    this.bus.archive('Archive', {
      archiveName: `${PLATFORM_BUS_NAME}-archive`,
      description: 'Full-history archive of the platform bus; source for EventBridge replay.',
      // Catch-all: every event on the bus carries the account ID in its envelope.
      eventPattern: { account: [this.account] }
    })

    const accessLogsBucket = this.createAccessLogsBucket()
    this.auditBucket = this.createAuditBucket(accessLogsBucket)
    this.auditDeliveryStream = this.createAuditDeliveryStream(this.auditBucket)

    new events.Rule(this, 'AuditRule', {
      ruleName: 'platform-audit-trail',
      description: 'Catch-all: delivers every event on the platform bus to the S3 audit trail.',
      eventBus: this.bus,
      eventPattern: { account: [this.account] },
      targets: [new targets.FirehoseDeliveryStream(this.auditDeliveryStream)]
    })

    this.publishSsmOutputs()
    this.addNagSuppressions(accessLogsBucket)
  }

  /** Server-access-log destination for the audit bucket (operational logs, not audit data). */
  private createAccessLogsBucket(): s3.Bucket {
    return new s3.Bucket(this, 'AuditAccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: ACCESS_LOG_EXPIRY }],
      removalPolicy: RemovalPolicy.RETAIN
    })
  }

  private createAuditBucket(accessLogsBucket: s3.IBucket): s3.Bucket {
    return new s3.Bucket(this, 'AuditBucket', {
      // Object Lock requires versioning; both must be set at creation time.
      objectLockEnabled: true,
      versioned: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(AUDIT_RETENTION),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'audit-bucket-access/',
      lifecycleRules: [
        {
          id: 'tier-audit-data',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: TRANSITION_TO_IA_AFTER },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: TRANSITION_TO_GLACIER_AFTER }
          ],
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: TRANSITION_TO_IA_AFTER
            }
          ]
        }
      ],
      removalPolicy: RemovalPolicy.RETAIN
    })
  }

  private createAuditDeliveryStream(auditBucket: s3.IBucket): firehose.DeliveryStream {
    const errorLogGroup = new logs.LogGroup(this, 'AuditDeliveryErrors', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY
    })

    return new firehose.DeliveryStream(this, 'AuditDeliveryStream', {
      deliveryStreamName: 'platform-audit-trail',
      encryption: firehose.StreamEncryption.awsOwnedKey(),
      destination: new firehose.S3Bucket(auditBucket, {
        dataOutputPrefix: AUDIT_PREFIX,
        errorOutputPrefix: AUDIT_ERROR_PREFIX,
        bufferingInterval: FIREHOSE_BUFFER_INTERVAL,
        bufferingSize: FIREHOSE_BUFFER_SIZE,
        compression: firehose.Compression.GZIP,
        // Newline-delimit records so Athena/jq can read the objects directly.
        processors: [new firehose.AppendDelimiterToRecordProcessor()],
        loggingConfig: new firehose.EnableLogging(errorLogGroup)
      })
    })
  }

  private publishSsmOutputs(): void {
    new StringParameter(this, 'BusNameParameter', {
      parameterName: EVENTS_SSM_PATHS.busName,
      description: 'Name of the platform custom event bus.',
      stringValue: this.bus.eventBusName
    })

    new StringParameter(this, 'BusArnParameter', {
      parameterName: EVENTS_SSM_PATHS.busArn,
      description: 'ARN of the platform custom event bus.',
      stringValue: this.bus.eventBusArn
    })

    new StringParameter(this, 'AuditBucketNameParameter', {
      parameterName: EVENTS_SSM_PATHS.auditBucketName,
      description: 'Name of the S3 audit-trail bucket (Object Lock, GOVERNANCE).',
      stringValue: this.auditBucket.bucketName
    })
  }

  private addNagSuppressions(accessLogsBucket: s3.Bucket): void {
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This bucket is the server-access-log destination for the audit bucket; ' +
          'logging it onto itself would recurse. It holds only S3 access logs.'
      }
    ])

    NagSuppressions.addResourceSuppressions(
      this.auditDeliveryStream,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Firehose writes audit objects with dynamic timestamped keys; an object-level ' +
            'wildcard on the audit bucket is required. The role is scoped to this bucket ' +
            'and its own error log group only.'
        }
      ],
      true
    )
  }
}
