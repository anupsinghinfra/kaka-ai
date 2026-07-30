import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { CfnStage, HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption
} from 'aws-cdk-lib/aws-dynamodb'
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'

/** SSM parameter paths this stack publishes (cross-stack contract; never Fn.importValue). */
export const REGISTRY_API_ENDPOINT_PARAMETER = '/platform/registry/api-endpoint'
export const REGISTRY_TABLE_NAME_PARAMETER = '/platform/registry/table-name'

/** SSM parameter paths this stack consumes (published by EventsStack / TokenServiceStack). */
export const CONSUMED_BUS_NAME_PARAMETER = '/platform/events/bus-name'
export const CONSUMED_BUS_ARN_PARAMETER = '/platform/events/bus-arn'
export const CONSUMED_SIGNING_KEY_ARN_PARAMETER = '/platform/secrets/token-signing-key-arn'

/** GSI for listing ventures by owner, newest first (mirrored in services/registry). */
export const OWNER_INDEX_NAME = 'ownerId-index'

/** Registry traffic is control-plane CRUD — low volume, bursty around builds. */
const API_THROTTLE_RATE_PER_SECOND = 20
const API_THROTTLE_BURST = 40

export interface RegistryStackProps extends StackProps {
  /** Physical name of the ventures table. Default: `ventures` (EXECUTION.md M0.5). */
  readonly venturesTableName?: string
  /** Log retention for handler and API access logs. Default three months. */
  readonly logRetention?: RetentionDays
}

/**
 * Venture registry (EXECUTION.md M0 item 5) — the M0 exit-criterion service:
 * a scoped capability token creates a venture record, the mutation event
 * lands on the platform bus (and thus the audit trail), and an unscoped
 * call gets a machine-readable 403.
 *
 * - DynamoDB `ventures` table: PK `ventureId`, GSI `ownerId-index`
 *   (ownerId + createdAt) for owner-scoped listing. On-demand, PITR,
 *   deletion protection, RETAIN — venture records are the platform's
 *   system of record.
 * - Lambda (Node 20 ARM, bundled from services/registry) behind an HTTP API.
 *   The API is deliberately **not** IAM-authorized: callers are agents
 *   holding capability JWTs, not AWS credentials. Authorization is enforced
 *   in the handler via `@platform/authorizer` (deny-by-default scopes,
 *   KMS-signed tokens) — EXECUTION.md §1 "blast-radius via tokens".
 * - Cross-stack inputs via SSM: platform bus name/ARN, token signing key ARN.
 *
 * Cross-stack outputs go to SSM under `/platform/registry/...`.
 */
export class RegistryStack extends Stack {
  constructor(scope: Construct, id: string, props: RegistryStackProps = {}) {
    super(scope, id, props)

    const logRetention = props.logRetention ?? RetentionDays.THREE_MONTHS

    const busName = StringParameter.valueForStringParameter(this, CONSUMED_BUS_NAME_PARAMETER)
    const busArn = StringParameter.valueForStringParameter(this, CONSUMED_BUS_ARN_PARAMETER)
    const signingKeyArn = StringParameter.valueForStringParameter(this, CONSUMED_SIGNING_KEY_ARN_PARAMETER)

    const venturesTable = this.createVenturesTable(props.venturesTableName ?? 'ventures')
    const { handlerRole, registryFunction } = this.createHandler(
      venturesTable,
      { busName, busArn, signingKeyArn },
      logRetention
    )
    const stage = this.createHttpApi(registryFunction, logRetention)

    this.publishSsmOutputs(stage, venturesTable)
    this.addNagSuppressions(handlerRole, registryFunction)
  }

  private createVenturesTable(tableName: string): Table {
    const table = new Table(this, 'VenturesTable', {
      tableName,
      partitionKey: { name: 'ventureId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN
    })

    table.addGlobalSecondaryIndex({
      indexName: OWNER_INDEX_NAME,
      partitionKey: { name: 'ownerId', type: AttributeType.STRING },
      sortKey: { name: 'createdAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL
    })

    return table
  }

  private createHandler(
    venturesTable: Table,
    ssm: { busName: string; busArn: string; signingKeyArn: string },
    logRetention: RetentionDays
  ): { handlerRole: Role; registryFunction: LambdaFunction } {
    const handlerLogGroup = new LogGroup(this, 'HandlerLogGroup', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN
    })

    const handlerRole = new Role(this, 'HandlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the registry Lambda (least privilege: ventures table RW, PutEvents on the platform bus, GetPublicKey on the signing key, own logs).'
    })
    handlerLogGroup.grantWrite(handlerRole)

    const registryFunction = new LambdaFunction(this, 'RegistryHandler', {
      description:
        'Venture registry API — capability-token-authorized CRUD over venture records; every mutation is published to the platform bus.',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: bundledRegistryCode(),
      role: handlerRole,
      logGroup: handlerLogGroup,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        VENTURES_TABLE_NAME: venturesTable.tableName,
        OWNER_INDEX_NAME,
        EVENT_BUS_NAME: ssm.busName,
        SIGNING_KEY_ARN: ssm.signingKeyArn,
        LOG_LEVEL: 'info'
      }
    })

    venturesTable.grantReadWriteData(registryFunction)

    handlerRole.addToPolicy(
      new PolicyStatement({
        sid: 'PublishPlatformEvents',
        actions: ['events:PutEvents'],
        resources: [ssm.busArn]
      })
    )

    handlerRole.addToPolicy(
      new PolicyStatement({
        sid: 'ReadTokenVerificationKey',
        actions: ['kms:GetPublicKey'],
        resources: [ssm.signingKeyArn]
      })
    )

    return { handlerRole, registryFunction }
  }

  private createHttpApi(registryFunction: LambdaFunction, logRetention: RetentionDays): HttpStage {
    const httpApi = new HttpApi(this, 'RegistryApi', {
      apiName: 'venture-registry',
      description:
        'Venture registry API. Authorization is application-layer capability JWTs (verified in the handler), not IAM.',
      createDefaultStage: false
    })

    const integration = new HttpLambdaIntegration('RegistryIntegration', registryFunction)

    httpApi.addRoutes({
      path: '/ventures',
      methods: [HttpMethod.POST, HttpMethod.GET],
      integration
    })

    httpApi.addRoutes({
      path: '/ventures/{ventureId}',
      methods: [HttpMethod.GET, HttpMethod.DELETE],
      integration
    })

    httpApi.addRoutes({
      path: '/ventures/{ventureId}/manifest',
      methods: [HttpMethod.PUT],
      integration
    })

    const accessLogGroup = new LogGroup(this, 'ApiAccessLogGroup', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN
    })

    const stage = new HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: API_THROTTLE_RATE_PER_SECOND,
        burstLimit: API_THROTTLE_BURST
      }
    })

    const cfnStage = stage.node.defaultChild as CfnStage
    cfnStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLatency: '$context.responseLatency',
        integrationErrorMessage: '$context.integrationErrorMessage'
      })
    }

    NagSuppressions.addResourceSuppressions(
      httpApi,
      [
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'Authorization is application-layer capability JWTs (KMS-signed, deny-by-default scopes) verified in the handler — agents hold capability tokens, not AWS credentials, so an IAM authorizer cannot apply (EXECUTION.md §1, blast-radius via tokens).'
        },
        {
          id: 'AwsSolutions-COG4',
          reason:
            'Callers are platform agents, not human end users; Cognito user-pool authorization does not apply. Authorization is capability JWTs verified in the handler.'
        }
      ],
      true
    )

    return stage
  }

  private publishSsmOutputs(stage: HttpStage, venturesTable: Table): void {
    new StringParameter(this, 'ApiEndpointParameter', {
      parameterName: REGISTRY_API_ENDPOINT_PARAMETER,
      description: 'Invoke URL of the venture-registry HTTP API ($default stage).',
      stringValue: stage.url
    })

    new StringParameter(this, 'TableNameParameter', {
      parameterName: REGISTRY_TABLE_NAME_PARAMETER,
      description: 'Name of the DynamoDB table holding venture records.',
      stringValue: venturesTable.tableName
    })
  }

  private addNagSuppressions(handlerRole: Role, registryFunction: LambdaFunction): void {
    NagSuppressions.addResourceSuppressions(
      handlerRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'grantReadWriteData scopes to the ventures table and its GSIs (table/index/* wildcard is the narrowest grant DynamoDB indexes allow); CloudWatch Logs requires a log-stream wildcard within the function log group. Bus and KMS grants are single-resource.'
        }
      ],
      true
    )

    NagSuppressions.addResourceSuppressions(registryFunction, [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Runtime pinned to Node.js 20 — the platform baseline (root .nvmrc / tsconfig target); upgraded deliberately, not implicitly.'
      }
    ])
  }
}

/**
 * Bundles services/registry/src/lambda.ts with the workspace-local esbuild
 * (no docker in the common path). Falls back to a loud failure inside the
 * container image if local bundling is impossible.
 */
function bundledRegistryCode(): Code {
  const registryDir = findRegistryDir()

  return Code.fromAsset(registryDir, {
    bundling: {
      image: Runtime.NODEJS_20_X.bundlingImage,
      command: [
        'bash',
        '-c',
        'echo "Local esbuild bundling failed — run pnpm install so services/registry/node_modules/.bin/esbuild exists" && exit 1'
      ],
      local: {
        tryBundle(outputDir: string): boolean {
          const esbuildBinary = join(registryDir, 'node_modules', '.bin', 'esbuild')

          if (!existsSync(esbuildBinary)) {
            return false
          }

          const result = spawnSync(
            esbuildBinary,
            [
              'src/lambda.ts',
              '--bundle',
              '--platform=node',
              '--target=node20',
              '--format=cjs',
              '--sourcemap',
              '--log-level=warning',
              `--outfile=${join(outputDir, 'index.js')}`
            ],
            { cwd: registryDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
          )

          if (result.status !== 0) {
            throw new Error(`esbuild bundling of registry failed:\n${result.stderr ?? 'unknown error'}`)
          }

          return true
        }
      }
    }
  })
}

/** Locates services/registry by walking up to the workspace root (works from src and compiled dist). */
function findRegistryDir(): string {
  let current = __dirname

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      const registryDir = join(current, 'services', 'registry')

      if (!existsSync(join(registryDir, 'src', 'lambda.ts'))) {
        throw new Error(`Found workspace root at ${current} but services/registry/src/lambda.ts is missing.`)
      }

      return registryDir
    }

    const parent = dirname(current)

    if (parent === current) {
      break
    }

    current = parent
  }

  throw new Error('Unable to locate the pnpm workspace root (pnpm-workspace.yaml) from the infra package.')
}
