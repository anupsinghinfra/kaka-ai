/**
 * Service configuration, loaded once at cold start from the environment.
 * Fails fast with a remediation hint when a required value is missing.
 */

/**
 * Issuer stamped by the token service into every capability JWT.
 * Must match `services/token-service/src/config.ts` TOKEN_ISSUER.
 */
export const TOKEN_ISSUER = 'urn:platform:token-service'

/** Venture identifiers, per `contracts/venture/venture.schema.json`. */
export const VENTURE_ID_PATTERN = /^venture-[a-z0-9][a-z0-9-]{1,61}$/

/** Default page size for `GET /ventures`. */
export const DEFAULT_PAGE_SIZE = 25

/** Hard ceiling on page size (unbounded queries are forbidden). */
export const MAX_PAGE_SIZE = 100

export interface ServiceConfig {
  readonly venturesTableName: string
  readonly ownerIndexName: string
  readonly eventBusName: string
  readonly signingKeyArn: string
  readonly logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  return {
    venturesTableName: requireEnv(env, 'VENTURES_TABLE_NAME'),
    ownerIndexName: requireEnv(env, 'OWNER_INDEX_NAME'),
    eventBusName: requireEnv(env, 'EVENT_BUS_NAME'),
    signingKeyArn: requireEnv(env, 'SIGNING_KEY_ARN'),
    logLevel: env['LOG_LEVEL'] ?? 'info'
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]

  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable ${name} is not configured. Set it on the registry Lambda.`)
  }

  return value
}
