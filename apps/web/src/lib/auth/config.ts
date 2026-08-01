/**
 * Cognito auth configuration — client-safe (no Node imports, no window).
 *
 * The app has two modes:
 * - "local mode": the NEXT_PUBLIC_COGNITO_* vars are unset. No auth gating,
 *   the header shows a subtle "local" badge, /login bounces to /ideas.
 * - "configured": both vars are present. /ideas* requires a signed-in
 *   Cognito session and the header shows the user's email + sign out.
 *
 * `readAuthEnv` references process.env.NEXT_PUBLIC_* literally so Next.js
 * inlines the values into the client bundle at build time. On the server the
 * same names are read at runtime (the repo-root .env is applied to
 * process.env by next.config.mjs / src/lib/env.ts).
 */

export interface AuthConfig {
  readonly userPoolId: string
  readonly userPoolClientId: string
  readonly region: string
}

export interface AuthEnvVars {
  readonly userPoolId?: string | undefined
  readonly userPoolClientId?: string | undefined
  readonly region?: string | undefined
}

export const DEFAULT_AWS_REGION = 'us-east-1'

/**
 * Resolves the auth config from raw env values. Returns undefined (local
 * mode) unless both the user pool id and client id are non-empty. The region
 * defaults to us-east-1.
 */
export function resolveAuthConfig(vars: AuthEnvVars): AuthConfig | undefined {
  const userPoolId = vars.userPoolId?.trim() ?? ''
  const userPoolClientId = vars.userPoolClientId?.trim() ?? ''
  if (userPoolId.length === 0 || userPoolClientId.length === 0) {
    return undefined
  }
  const region = vars.region?.trim() ?? ''
  return {
    userPoolId,
    userPoolClientId,
    region: region.length === 0 ? DEFAULT_AWS_REGION : region
  }
}

/** Reads the auth env vars. Literal references are required for Next inlining. */
export function readAuthEnv(): AuthEnvVars {
  return {
    userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
    userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
    region: process.env.NEXT_PUBLIC_AWS_REGION
  }
}

/** Auth config from the environment, or undefined in local mode. */
export function getAuthConfig(): AuthConfig | undefined {
  return resolveAuthConfig(readAuthEnv())
}

/** True when Cognito is configured (auth gating active). */
export function isAuthConfigured(): boolean {
  return getAuthConfig() !== undefined
}

/**
 * Where "Start building" should send the visitor: straight to the ideas
 * dashboard in local mode, through /login when Cognito is configured
 * (/login immediately forwards already-signed-in users to /ideas).
 */
export function startBuildingHref(isConfigured: boolean): string {
  return isConfigured ? '/login' : '/ideas'
}
