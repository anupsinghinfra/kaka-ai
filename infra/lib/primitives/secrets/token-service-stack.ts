import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import {
  CfnStage,
  HttpApi,
  HttpMethod,
  HttpStage
} from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms'
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'

/** SSM parameter paths this stack publishes (cross-stack contract; never Fn.importValue). */
export const TOKEN_SIGNING_KEY_ARN_PARAMETER = '/platform/secrets/token-signing-key-arn'
export const TOKEN_SERVICE_ENDPOINT_PARAMETER = '/platform/secrets/token-service-endpoint'
export const POLICIES_TABLE_NAME_PARAMETER = '/platform/secrets/policies-table-name'

/** Defaults mirrored by services/token-service/src/config.ts (documented there). */
const DEFAULT_MAX_TOKEN_TTL_SECONDS = 900
const DEFAULT_DEFAULT_TOKEN_TTL_SECONDS = 300

/** Issuance is cheap and bursty (agents re-request instead of caching). */
const API_THROTTLE_RATE_PER_SECOND = 50
const API_THROTTLE_BURST = 100

export interface TokenServiceStackProps extends StackProps {
  /** Physical name of the policy table. Default: `policies` (EXECUTION.md M0.4). */
  readonly policiesTableName?: string
  /** Default token TTL stamped when the caller omits ttlSeconds. Default 300. */
  readonly defaultTokenTtlSeconds?: number
  /** Hard ceiling on token TTL. Default 900 (15 minutes). */
  readonly maxTokenTtlSeconds?: number
  /** Log retention for handler and API access logs. Default three months. */
  readonly logRetention?: RetentionDays
}

/**
 * Capability token service (EXECUTION.md M0 item 4).
 *
 * - KMS asymmetric RSA_2048 SIGN_VERIFY key: signs capability JWTs (PS256).
 *   Automatic annual rotation is a symmetric-key-only KMS feature — it is
 *   **not applicable** to asymmetric signing keys, because rotating the
 *   backing material would silently invalidate the published public key.
 *   Rotation here is manual key *succession*: create a new key, publish its
 *   ARN/kid, keep the old key verifiable until the 15-minute max TTL has
 *   drained, then retire it. Tokens being minutes-lived makes this cheap.
 * - DynamoDB `policies` table: per-principal policy documents, deny-by-default.
 * - Lambda (Node 20, bundled from services/token-service) behind an HTTP API
 *   with a single IAM-authorized route: POST /tokens.
 *
 * Cross-stack outputs go to SSM under `/platform/secrets/...`.
 */
export class TokenServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: TokenServiceStackProps = {}) {
    super(scope, id, props)

    const logRetention = props.logRetention ?? RetentionDays.THREE_MONTHS
    const maxTokenTtlSeconds = props.maxTokenTtlSeconds ?? DEFAULT_MAX_TOKEN_TTL_SECONDS
    const defaultTokenTtlSeconds = props.defaultTokenTtlSeconds ?? DEFAULT_DEFAULT_TOKEN_TTL_SECONDS

    if (defaultTokenTtlSeconds > maxTokenTtlSeconds) {
      throw new Error(
        `defaultTokenTtlSeconds (${defaultTokenTtlSeconds}) must not exceed maxTokenTtlSeconds (${maxTokenTtlSeconds}).`
      )
    }

    const signingKey = new Key(this, 'TokenSigningKey', {
      keySpec: KeySpec.RSA_2048,
      keyUsage: KeyUsage.SIGN_VERIFY,
      alias: 'platform/token-signing',
      description:
        'Signs platform capability JWTs (PS256). Asymmetric: no automatic rotation; rotate by key succession (see TokenServiceStack docs).',
      // Losing the key is survivable (max token TTL is 15 min) but retaining
      // avoids a platform-wide auth blip on accidental stack deletion.
      removalPolicy: RemovalPolicy.RETAIN
    })

    const policiesTable = new Table(this, 'PoliciesTable', {
      tableName: props.policiesTableName ?? 'policies',
      partitionKey: { name: 'principalId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN
    })

    const handlerLogGroup = new LogGroup(this, 'HandlerLogGroup', {
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN
    })

    const handlerRole = new Role(this, 'HandlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the token-service issuance Lambda (least privilege: sign, read policies, write own logs).'
    })
    handlerLogGroup.grantWrite(handlerRole)

    const issueTokenFunction = new LambdaFunction(this, 'IssueTokenHandler', {
      description: 'POST /tokens — issues short-lived, policy-constrained capability JWTs signed via KMS.',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: bundledTokenServiceCode(),
      role: handlerRole,
      logGroup: handlerLogGroup,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        POLICIES_TABLE_NAME: policiesTable.tableName,
        SIGNING_KEY_ID: signingKey.keyArn,
        MAX_TOKEN_TTL_SECONDS: String(maxTokenTtlSeconds),
        DEFAULT_TOKEN_TTL_SECONDS: String(defaultTokenTtlSeconds),
        LOG_LEVEL: 'info'
      }
    })

    signingKey.grant(issueTokenFunction, 'kms:Sign', 'kms:GetPublicKey')
    policiesTable.grantReadData(issueTokenFunction)

    const httpApi = new HttpApi(this, 'TokenApi', {
      apiName: 'token-service',
      description: 'Capability token issuance API (IAM-authorized platform-internal endpoint).',
      createDefaultStage: false
    })

    httpApi.addRoutes({
      path: '/tokens',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('IssueTokenIntegration', issueTokenFunction),
      // SigV4: only platform IAM principals may mint tokens. The policy table
      // then decides per-principal what those tokens may carry.
      authorizer: new HttpIamAuthorizer()
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
        caller: '$context.identity.caller',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLatency: '$context.responseLatency',
        integrationErrorMessage: '$context.integrationErrorMessage'
      })
    }

    new StringParameter(this, 'SigningKeyArnParameter', {
      parameterName: TOKEN_SIGNING_KEY_ARN_PARAMETER,
      description: 'ARN (and JWT kid) of the KMS key that signs capability tokens.',
      stringValue: signingKey.keyArn
    })

    new StringParameter(this, 'ApiEndpointParameter', {
      parameterName: TOKEN_SERVICE_ENDPOINT_PARAMETER,
      description: 'Invoke URL of the token-service HTTP API ($default stage).',
      stringValue: stage.url
    })

    new StringParameter(this, 'PoliciesTableNameParameter', {
      parameterName: POLICIES_TABLE_NAME_PARAMETER,
      description: 'Name of the DynamoDB table holding per-principal policy documents.',
      stringValue: policiesTable.tableName
    })

    this.addNagSuppressions(handlerRole, issueTokenFunction, signingKey)
  }

  private addNagSuppressions(handlerRole: Role, issueTokenFunction: LambdaFunction, signingKey: Key): void {
    NagSuppressions.addResourceSuppressions(
      handlerRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CloudWatch Logs requires a log-stream wildcard within the function log group ARN; all other grants are resource-scoped (one KMS key, one table).'
        }
      ],
      true
    )

    NagSuppressions.addResourceSuppressions(issueTokenFunction, [
      {
        id: 'AwsSolutions-L1',
        reason:
          'Runtime pinned to Node.js 20 — the platform baseline (root .nvmrc / tsconfig target); upgraded deliberately, not implicitly.'
      }
    ])

    NagSuppressions.addResourceSuppressions(signingKey, [
      {
        id: 'AwsSolutions-KMS5',
        reason:
          'Asymmetric SIGN_VERIFY keys do not support automatic rotation; rotation is manual key succession (new key + published kid, old key drained over the 15-minute max token TTL).'
      }
    ])
  }
}

/**
 * Bundles services/token-service/src/lambda.ts with the workspace-local
 * esbuild (no docker in the common path). Falls back to a loud failure inside
 * the container image if local bundling is impossible.
 */
function bundledTokenServiceCode(): Code {
  const tokenServiceDir = findTokenServiceDir()

  return Code.fromAsset(tokenServiceDir, {
    bundling: {
      image: Runtime.NODEJS_20_X.bundlingImage,
      command: [
        'bash',
        '-c',
        'echo "Local esbuild bundling failed — run pnpm install so services/token-service/node_modules/.bin/esbuild exists" && exit 1'
      ],
      local: {
        tryBundle(outputDir: string): boolean {
          const esbuildBinary = join(tokenServiceDir, 'node_modules', '.bin', 'esbuild')

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
            { cwd: tokenServiceDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
          )

          if (result.status !== 0) {
            throw new Error(`esbuild bundling of token-service failed:\n${result.stderr ?? 'unknown error'}`)
          }

          return true
        }
      }
    }
  })
}

/** Locates services/token-service by walking up to the workspace root (works from src and compiled dist). */
function findTokenServiceDir(): string {
  let current = __dirname

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      const tokenServiceDir = join(current, 'services', 'token-service')

      if (!existsSync(join(tokenServiceDir, 'src', 'lambda.ts'))) {
        throw new Error(`Found workspace root at ${current} but services/token-service/src/lambda.ts is missing.`)
      }

      return tokenServiceDir
    }

    const parent = dirname(current)

    if (parent === current) {
      break
    }

    current = parent
  }

  throw new Error('Unable to locate the pnpm workspace root (pnpm-workspace.yaml) from the infra package.')
}
