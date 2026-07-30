import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Duration, Stack, type StackProps, Token } from 'aws-cdk-lib'
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager'
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  type IDistribution,
  KeyValueStore,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { AaaaRecord, ARecord, type IHostedZone, PublicHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53'
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets'
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3'
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'

export interface NetworkStackProps extends StackProps {
  /** Apex domain the platform serves ventures under (e.g. `example.app`). */
  readonly platformDomain: string
}

/** SSM prefix for every parameter this stack publishes. */
const SSM_PREFIX = '/platform/network'

/** Name of the CloudFront KeyValueStore holding hostname -> target routes. */
const ROUTING_TABLE_NAME = 'routing-table'

/**
 * Request header the viewer-request function stashes the route target in.
 * Must match ROUTE_TARGET_HEADER in function/routing-decision.js.
 */
const ROUTE_TARGET_HEADER = 'x-route-target'

/** CloudFront requires its certificate (and this stack) in us-east-1. */
const CLOUDFRONT_REGION = 'us-east-1'

const PARKING_OBJECT_KEY = 'parking/503.json'
const PARKING_OBJECT_PATH = `/${PARKING_OBJECT_KEY}`
const ACCESS_LOG_EXPIRATION_DAYS = 90

/** Body of the static parking object served (as a 503) for routed hosts. */
const PARKING_RESPONSE_BODY = {
  error: {
    code: 'ORIGIN_NOT_CONFIGURED',
    message: 'This hostname is routed, but its cell-ingress origin is not wired yet.'
  }
} as const

/**
 * Network primitive — platform domain, edge routing, routing table (M0 item 2).
 *
 * - Route 53 public hosted zone for the platform domain.
 * - ACM certificate (apex + `*.{domain}`), DNS-validated against that zone.
 *   Validation completes at deploy time only, never at synth.
 * - CloudFront KeyValueStore `routing-table` (empty; the deployment registry
 *   writes `{deploy-id}.{venture}.{domain}` -> cell-ingress entries via
 *   `@platform/routing`; promote/rollback are pointer flips in this store).
 * - CloudFront distribution with wildcard aliases and a viewer-request
 *   function that resolves Host against the KVS: unknown host -> edge 404,
 *   known host -> pass-through with the target in `x-route-target`.
 * - PARKING ORIGIN (temporary): a private S3 bucket whose only object is a
 *   static 503 JSON payload, so routed hosts get a clean "origin not wired"
 *   answer. M1 replaces this with real cell-ingress origin selection —
 *   likely a Lambda@Edge origin-request handler or a shared ingress ALB that
 *   dials the cell named by `x-route-target`. That choice is an open M1
 *   decision; nothing here prebuilds it.
 * - Route 53 alias records (apex + wildcard, A and AAAA) -> the distribution.
 *
 * Cross-stack consumers read outputs from SSM under `/platform/network/...`
 * (never `Fn.importValue` — see PLAN.md §2).
 */
export class NetworkStack extends Stack {
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)

    assertCloudFrontCompatibleRegion(this)

    const zone = new PublicHostedZone(this, 'PlatformHostedZone', {
      zoneName: props.platformDomain,
      comment: 'Venture platform apex zone; deployments live on subdomains.'
    })

    const certificate = new Certificate(this, 'WildcardCertificate', {
      domainName: props.platformDomain,
      subjectAlternativeNames: [`*.${props.platformDomain}`],
      validation: CertificateValidation.fromDns(zone)
    })

    const routingTable = new KeyValueStore(this, 'RoutingTable', {
      keyValueStoreName: ROUTING_TABLE_NAME,
      comment:
        'hostname -> cell-ingress target. Written by the deployment registry ' +
        'via @platform/routing; read by the viewer-request function.'
    })

    const viewerRouter = new CloudFrontFunction(this, 'ViewerRouterFunction', {
      runtime: FunctionRuntime.JS_2_0,
      keyValueStore: routingTable,
      code: FunctionCode.fromInline(loadViewerRouterCode()),
      comment: 'Resolves Host against the routing-table KVS; 404 for unknown hosts.'
    })

    const accessLogBucket = createAccessLogBucket(this)
    const parkingBucket = createParkingBucket(this, accessLogBucket)
    const parkingDeployment = new BucketDeployment(this, 'ParkingObjectDeployment', {
      destinationBucket: parkingBucket,
      sources: [Source.jsonData(PARKING_OBJECT_KEY, PARKING_RESPONSE_BODY)]
    })

    const distribution = new Distribution(this, 'PlatformDistribution', {
      comment: `Venture platform edge for ${props.platformDomain}`,
      domainNames: [props.platformDomain, `*.${props.platformDomain}`],
      certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket: accessLogBucket,
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(parkingBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        // Routing is per-request and the parking origin is a stub; M1
        // revisits caching alongside real origin selection.
        cachePolicy: CachePolicy.CACHING_DISABLED,
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: viewerRouter
          }
        ]
      },
      // Any path a routed host requests misses the parking bucket (S3 answers
      // 403/404), which we surface as the static 503 parking payload.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 503,
          responsePagePath: PARKING_OBJECT_PATH,
          ttl: Duration.seconds(0)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 503,
          responsePagePath: PARKING_OBJECT_PATH,
          ttl: Duration.seconds(0)
        }
      ]
    })

    createAliasRecords(this, zone, distribution, props.platformDomain)
    publishNetworkParameters(this, { zone, certificate, distribution, routingTable })
    addNagSuppressions(this, distribution, accessLogBucket, parkingDeployment)
  }
}

function assertCloudFrontCompatibleRegion(stack: Stack): void {
  if (!Token.isUnresolved(stack.region) && stack.region !== CLOUDFRONT_REGION) {
    throw new Error(
      `NetworkStack must deploy to ${CLOUDFRONT_REGION} ` +
        `(CloudFront requires its ACM certificate there); got "${stack.region}".`
    )
  }
}

/**
 * Assembles the viewer-request function source at synth time: the checked-in
 * wrapper (CloudFront runtime glue) with the pure decision logic injected at
 * the placeholder line. Both files live in ./function and are unit-tested in
 * plain Node (see infra/test/network-stack.test.ts).
 */
function loadViewerRouterCode(): string {
  const functionDir = resolveFunctionDir()
  const decisionSource = readFileSync(join(functionDir, 'routing-decision.js'), 'utf8')
  const wrapperSource = readFileSync(join(functionDir, 'viewer-request.js'), 'utf8')
  const placeholder = '// __ROUTING_DECISION_SOURCE__'

  if (!wrapperSource.includes(placeholder)) {
    throw new Error(`viewer-request.js is missing the "${placeholder}" injection marker.`)
  }

  return wrapperSource.replace(placeholder, () => decisionSource)
}

/** Resolves ./function next to this file, tolerating a compiled dist/ layout. */
function resolveFunctionDir(): string {
  const primary = join(__dirname, 'function')
  if (existsSync(primary)) {
    return primary
  }

  const fromSource = join(__dirname.replace(`${sep}dist${sep}`, sep), 'function')
  if (existsSync(fromSource)) {
    return fromSource
  }

  throw new Error(`CloudFront function sources not found at ${primary} or ${fromSource}.`)
}

/** Shared destination for CloudFront and S3 access logs. */
function createAccessLogBucket(scope: Construct): Bucket {
  return new Bucket(scope, 'AccessLogBucket', {
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    // CloudFront legacy log delivery writes via ACL, so object ownership
    // must permit ACLs on this bucket.
    objectOwnership: ObjectOwnership.OBJECT_WRITER,
    lifecycleRules: [{ expiration: Duration.days(ACCESS_LOG_EXPIRATION_DAYS) }]
  })
}

/** Private bucket holding only the static parking 503 object. */
function createParkingBucket(scope: Construct, accessLogBucket: Bucket): Bucket {
  return new Bucket(scope, 'ParkingOriginBucket', {
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    serverAccessLogsBucket: accessLogBucket,
    serverAccessLogsPrefix: 's3/parking/'
  })
}

function createAliasRecords(
  scope: Construct,
  zone: IHostedZone,
  distribution: IDistribution,
  platformDomain: string
): void {
  const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution))

  new ARecord(scope, 'ApexAliasRecord', { zone, target })
  new AaaaRecord(scope, 'ApexAliasRecordV6', { zone, target })
  new ARecord(scope, 'WildcardAliasRecord', {
    zone,
    recordName: `*.${platformDomain}`,
    target
  })
  new AaaaRecord(scope, 'WildcardAliasRecordV6', {
    zone,
    recordName: `*.${platformDomain}`,
    target
  })
}

interface NetworkOutputs {
  readonly zone: PublicHostedZone
  readonly certificate: Certificate
  readonly distribution: Distribution
  readonly routingTable: KeyValueStore
}

function publishNetworkParameters(scope: Construct, outputs: NetworkOutputs): void {
  const parameters: ReadonlyArray<{ id: string; name: string; value: string; description: string }> = [
    {
      id: 'HostedZoneIdParameter',
      name: `${SSM_PREFIX}/hosted-zone-id`,
      value: outputs.zone.hostedZoneId,
      description: 'Route 53 hosted zone id for the platform domain.'
    },
    {
      id: 'HostedZoneNameParameter',
      name: `${SSM_PREFIX}/hosted-zone-name`,
      value: outputs.zone.zoneName,
      description: 'Route 53 hosted zone name (the platform apex domain).'
    },
    {
      id: 'CertificateArnParameter',
      name: `${SSM_PREFIX}/certificate-arn`,
      value: outputs.certificate.certificateArn,
      description: 'ACM certificate ARN covering the apex and *.{domain}.'
    },
    {
      id: 'DistributionIdParameter',
      name: `${SSM_PREFIX}/distribution-id`,
      value: outputs.distribution.distributionId,
      description: 'CloudFront distribution id for the platform edge.'
    },
    {
      id: 'DistributionDomainNameParameter',
      name: `${SSM_PREFIX}/distribution-domain-name`,
      value: outputs.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name (alias record target).'
    },
    {
      id: 'RoutingTableKvsIdParameter',
      name: `${SSM_PREFIX}/routing-table-kvs-id`,
      value: outputs.routingTable.keyValueStoreId,
      description: 'CloudFront KeyValueStore id of the routing table.'
    },
    {
      id: 'RoutingTableKvsArnParameter',
      name: `${SSM_PREFIX}/routing-table-kvs-arn`,
      value: outputs.routingTable.keyValueStoreArn,
      description: 'CloudFront KeyValueStore ARN of the routing table (writer input).'
    },
    {
      id: 'RouteTargetHeaderParameter',
      name: `${SSM_PREFIX}/route-target-header`,
      value: ROUTE_TARGET_HEADER,
      description: 'Request header carrying the resolved route target to the origin layer.'
    }
  ]

  for (const parameter of parameters) {
    new StringParameter(scope, parameter.id, {
      parameterName: parameter.name,
      stringValue: parameter.value,
      description: parameter.description
    })
  }
}

function addNagSuppressions(
  stack: Stack,
  distribution: Distribution,
  accessLogBucket: Bucket,
  parkingDeployment: BucketDeployment
): void {
  NagSuppressions.addResourceSuppressions(distribution, [
    {
      id: 'AwsSolutions-CFR1',
      reason: 'Ventures serve a global audience; no geo-restriction requirement exists.'
    },
    {
      id: 'AwsSolutions-CFR2',
      reason:
        'WAF is deferred until public traffic starts (M2+). The viewer-request ' +
        'function fails closed with a 404 for every unregistered hostname.'
    }
  ])

  NagSuppressions.addResourceSuppressions(accessLogBucket, [
    {
      id: 'AwsSolutions-S1',
      reason: 'This is the access-log destination bucket; logging it onto itself recurses.'
    }
  ])

  NagSuppressions.addResourceSuppressions(
    parkingDeployment.handlerRole,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'aws-s3-deployment singleton handler uses the AWS managed Lambda basic ' +
          'execution role; the construct owns this role.'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'aws-s3-deployment requires object-level wildcards scoped to the CDK ' +
          'assets bucket and the parking bucket to copy the parking object.'
      }
    ],
    true
  )

  for (const child of stack.node.children) {
    if (child.node.id.startsWith('Custom::CDKBucketDeployment')) {
      NagSuppressions.addResourceSuppressions(
        child,
        [
          {
            id: 'AwsSolutions-L1',
            reason:
              'Runtime is pinned by the aws-s3-deployment construct and upgrades ' +
              'with aws-cdk-lib.'
          }
        ],
        true
      )
    }
  }
}
