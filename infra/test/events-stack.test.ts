import { App, Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { EVENTS_SSM_PATHS, EventsStack, PLATFORM_BUS_NAME } from '../lib/primitives/events/events-stack'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }

function createStack(): EventsStack {
  // Arrange: mirror the app-level feature flag from infra/cdk.json that the
  // audit bucket's access-logging setup depends on.
  const app = new App({
    context: { '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true }
  })
  return new EventsStack(app, 'TestEvents', { env: TEST_ENV })
}

function synthesizeTemplate(): Template {
  // Act
  return Template.fromStack(createStack())
}

describe('EventsStack', () => {
  test('creates the platform custom event bus', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::Events::EventBus', {
      Name: PLATFORM_BUS_NAME
    })
  })

  test('attaches a catch-all archive to the bus with indefinite retention', () => {
    const template = synthesizeTemplate()

    // Assert
    template.resourceCountIs('AWS::Events::Archive', 1)
    template.hasResourceProperties('AWS::Events::Archive', {
      SourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('PlatformBus'), 'Arn'] },
      EventPattern: { account: [TEST_ENV.account] }
    })
    // RetentionDays 0 is EventBridge's encoding of "retain indefinitely".
    template.hasResourceProperties('AWS::Events::Archive', { RetentionDays: 0 })
  })

  test('routes every bus event to the Firehose audit stream', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: { Ref: Match.stringLikeRegexp('PlatformBus') },
      EventPattern: { account: [TEST_ENV.account] },
      State: 'ENABLED',
      Targets: [
        Match.objectLike({
          Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('AuditDeliveryStream'), 'Arn'] }
        })
      ]
    })
  })

  test('configures Firehose with ~60s/5MB buffering and date-partitioned audit prefix', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      ExtendedS3DestinationConfiguration: Match.objectLike({
        BucketARN: { 'Fn::GetAtt': [Match.stringLikeRegexp('AuditBucket'), 'Arn'] },
        BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
        Prefix: 'audit/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/'
      })
    })
  })

  test('audit bucket is versioned with Object Lock in GOVERNANCE mode', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 365 } }
      }
    })
  })

  test('audit bucket blocks all public access and is encrypted', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }
        ]
      }
    })
  })

  test('audit bucket lifecycle tiers data to IA and Glacier', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            Transitions: [
              { StorageClass: 'STANDARD_IA', TransitionInDays: 30 },
              { StorageClass: 'GLACIER', TransitionInDays: 180 }
            ]
          })
        ])
      }
    })
  })

  test('publishes bus name, bus ARN, and audit bucket name to SSM', () => {
    const template = synthesizeTemplate()

    // Assert
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: EVENTS_SSM_PATHS.busName,
      Value: { Ref: Match.stringLikeRegexp('PlatformBus') }
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: EVENTS_SSM_PATHS.busArn,
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('PlatformBus'), 'Arn'] }
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: EVENTS_SSM_PATHS.auditBucketName,
      Value: { Ref: Match.stringLikeRegexp('AuditBucket') }
    })
  })

  test('passes cdk-nag AwsSolutions checks with only justified suppressions', () => {
    // Arrange
    const stack = createStack()
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }))

    // Act
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    )

    // Assert
    expect(errors).toHaveLength(0)
  })
})
