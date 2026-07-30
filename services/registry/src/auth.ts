/**
 * Capability-token authentication for registry routes.
 *
 * Extraction + verification only; scope checks stay with each route
 * (`requireScope`), and status mapping (401 vs 403) lives in the handler's
 * error mapper so every denial is machine-readable.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { verifyToken, type PublicKeyInput, type VerifiedToken } from '@platform/authorizer'
import { TOKEN_ISSUER } from './config'
import { RegistryError } from './errors'

/** Clock-skew leeway when verifying capability tokens (seconds). */
const CLOCK_TOLERANCE_SECONDS = 5

const BEARER_PREFIX = 'Bearer '

/**
 * Verifies the request's `Authorization: Bearer` capability token.
 *
 * - Missing/non-Bearer header → `RegistryError` MISSING_TOKEN (401).
 * - Verification failures propagate as `AuthorizationError` (mapped to
 *   401/403/500 by the handler).
 */
export async function authenticate(
  event: APIGatewayProxyEventV2,
  getVerificationKey: () => Promise<PublicKeyInput>,
  now?: () => Date
): Promise<VerifiedToken> {
  const token = extractBearerToken(event)

  return verifyToken(
    token,
    { getPublicKey: () => getVerificationKey() },
    {
      issuer: TOKEN_ISSUER,
      clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS,
      ...(now !== undefined ? { now: now() } : {})
    }
  )
}

function extractBearerToken(event: APIGatewayProxyEventV2): string {
  // HTTP API v2 lowercases header names before invoking the integration.
  const header = event.headers?.['authorization']

  if (header === undefined || header.length === 0) {
    throw missingToken('Request has no Authorization header')
  }

  if (!header.startsWith(BEARER_PREFIX)) {
    throw missingToken('Authorization header is not a Bearer token')
  }

  const token = header.slice(BEARER_PREFIX.length).trim()

  if (token.length === 0) {
    throw missingToken('Bearer token is empty')
  }

  return token
}

function missingToken(message: string): RegistryError {
  return new RegistryError(
    'MISSING_TOKEN',
    401,
    message,
    'Send "Authorization: Bearer <capability JWT>" using a token issued by the platform token service.'
  )
}
