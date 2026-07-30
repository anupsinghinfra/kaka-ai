import type { App } from 'aws-cdk-lib'

/**
 * Deployment configuration for the platform, resolved from CDK context.
 *
 * All values MUST come from context (`cdk.json` or `--context`); stack code
 * never hardcodes account IDs, regions, or domains.
 */

/**
 * How the app is deployed:
 * - `direct`: synthesize the bare prod Stage for `cdk deploy` (the default —
 *   keeps local workflows and tests working).
 * - `pipeline`: synthesize the self-mutating CodePipeline stack that contains
 *   the same prod Stage (EXECUTION.md M0 item 1: `main → prod` with canary gate).
 */
export type DeployVia = 'direct' | 'pipeline'

interface BasePlatformConfig {
  /** AWS account ID of the single prod environment (the OnCell account). */
  readonly prodAccount: string
  /** AWS region of the prod environment. */
  readonly prodRegion: string
  /** Apex domain the platform serves ventures under (e.g. `example.app`). */
  readonly platformDomain: string
}

export interface DirectPlatformConfig extends BasePlatformConfig {
  readonly deployVia: 'direct'
}

export interface PipelinePlatformConfig extends BasePlatformConfig {
  readonly deployVia: 'pipeline'
  /** ARN of the CodeStar/CodeConnections connection authorized against GitHub. */
  readonly pipelineConnectionArn: string
  /** GitHub repository the pipeline tracks, as `owner/repo`. */
  readonly pipelineRepo: string
}

export type PlatformConfig = DirectPlatformConfig | PipelinePlatformConfig

const REQUIRED_CONTEXT_KEYS = ['prodAccount', 'prodRegion', 'platformDomain'] as const

/** Required only when `deployVia=pipeline`; placeholders are fine in direct mode. */
const PIPELINE_CONTEXT_KEYS = ['pipelineConnectionArn', 'pipelineRepo'] as const

const DEPLOY_VIA_VALUES: readonly DeployVia[] = ['direct', 'pipeline']

const PLACEHOLDER_PREFIX = 'REPLACE_ME'

function resolveContextValue(app: App, key: string): string {
  const value: unknown = app.node.tryGetContext(key)

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing required CDK context key "${key}". ` +
        `Set it in infra/cdk.json or pass --context ${key}=<value>.`
    )
  }

  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error(
      `CDK context key "${key}" is still the placeholder "${value}". ` +
        `Replace it in infra/cdk.json or pass --context ${key}=<value>.`
    )
  }

  return value
}

function resolveDeployVia(app: App): DeployVia {
  const value: unknown = app.node.tryGetContext('deployVia') ?? 'direct'

  if (typeof value !== 'string' || !DEPLOY_VIA_VALUES.includes(value as DeployVia)) {
    throw new Error(
      `CDK context key "deployVia" must be one of ${DEPLOY_VIA_VALUES.map((v) => `"${v}"`).join(' | ')}, ` +
        `got "${String(value)}". Set it in infra/cdk.json or pass --context deployVia=<value>.`
    )
  }

  return value as DeployVia
}

function validatePipelineRepo(pipelineRepo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(pipelineRepo)) {
    throw new Error(
      `CDK context key "pipelineRepo" must be "owner/repo" (e.g. "my-org/kaka"), got "${pipelineRepo}".`
    )
  }
}

function validatePipelineConnectionArn(pipelineConnectionArn: string): void {
  if (!pipelineConnectionArn.startsWith('arn:')) {
    throw new Error(
      `CDK context key "pipelineConnectionArn" must be a CodeStar/CodeConnections connection ARN, ` +
        `got "${pipelineConnectionArn}".`
    )
  }
}

/**
 * Reads and validates platform configuration from CDK context.
 * Fails fast with a remediation hint when a key is missing or unreplaced.
 * Pipeline keys are validated only when `deployVia=pipeline`, so the
 * checked-in placeholders never break the default direct path.
 */
export function loadPlatformConfig(app: App): PlatformConfig {
  const [prodAccount, prodRegion, platformDomain] = REQUIRED_CONTEXT_KEYS.map((key) =>
    resolveContextValue(app, key)
  )
  const base: BasePlatformConfig = { prodAccount, prodRegion, platformDomain }

  const deployVia = resolveDeployVia(app)

  if (deployVia === 'direct') {
    return { ...base, deployVia }
  }

  const [pipelineConnectionArn, pipelineRepo] = PIPELINE_CONTEXT_KEYS.map((key) =>
    resolveContextValue(app, key)
  )
  validatePipelineConnectionArn(pipelineConnectionArn)
  validatePipelineRepo(pipelineRepo)

  return { ...base, deployVia, pipelineConnectionArn, pipelineRepo }
}
