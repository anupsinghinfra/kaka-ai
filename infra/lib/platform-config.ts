import type { App } from 'aws-cdk-lib'

/**
 * Deployment configuration for the platform, resolved from CDK context.
 *
 * All values MUST come from context (`cdk.json` or `--context`); stack code
 * never hardcodes account IDs, regions, or domains.
 */
export interface PlatformConfig {
  /** AWS account ID of the single prod environment (the OnCell account). */
  readonly prodAccount: string
  /** AWS region of the prod environment. */
  readonly prodRegion: string
  /** Apex domain the platform serves ventures under (e.g. `example.app`). */
  readonly platformDomain: string
}

const REQUIRED_CONTEXT_KEYS = ['prodAccount', 'prodRegion', 'platformDomain'] as const

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

/**
 * Reads and validates platform configuration from CDK context.
 * Fails fast with a remediation hint when a key is missing or unreplaced.
 */
export function loadPlatformConfig(app: App): PlatformConfig {
  const [prodAccount, prodRegion, platformDomain] = REQUIRED_CONTEXT_KEYS.map((key) =>
    resolveContextValue(app, key)
  )

  return { prodAccount, prodRegion, platformDomain }
}
