/**
 * Service configuration, loaded once at cold start from the environment.
 * Fails fast with a remediation hint when a required value is missing.
 */

/** Hard ceiling on token lifetime (EXECUTION.md §1: minutes-scale TTLs). */
export const MAX_TTL_SECONDS = 900

/** Default token lifetime when the caller does not specify one. */
export const DEFAULT_TTL_SECONDS = 300

/** Issuer claim stamped into every token this service signs. */
export const TOKEN_ISSUER = 'urn:platform:token-service'

export interface ServiceConfig {
  readonly policiesTableName: string
  readonly signingKeyId: string
  readonly defaultTtlSeconds: number
  readonly maxTtlSeconds: number
  readonly logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const policiesTableName = requireEnv(env, 'POLICIES_TABLE_NAME')
  const signingKeyId = requireEnv(env, 'SIGNING_KEY_ID')
  const defaultTtlSeconds = readTtl(env, 'DEFAULT_TOKEN_TTL_SECONDS', DEFAULT_TTL_SECONDS)
  const maxTtlSeconds = readTtl(env, 'MAX_TOKEN_TTL_SECONDS', MAX_TTL_SECONDS)

  if (defaultTtlSeconds > maxTtlSeconds) {
    throw new Error(
      `DEFAULT_TOKEN_TTL_SECONDS (${defaultTtlSeconds}) must not exceed MAX_TOKEN_TTL_SECONDS (${maxTtlSeconds}).`
    )
  }

  return {
    policiesTableName,
    signingKeyId,
    defaultTtlSeconds,
    maxTtlSeconds,
    logLevel: env['LOG_LEVEL'] ?? 'info'
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]

  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} is not configured. Set it on the token-service Lambda.`)
  }

  return value
}

function readTtl(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]

  if (raw === undefined || raw.length === 0) {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TTL_SECONDS) {
    throw new Error(`Environment variable ${name} must be an integer between 1 and ${MAX_TTL_SECONDS}, got "${raw}".`)
  }

  return parsed
}
