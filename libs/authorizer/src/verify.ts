/**
 * Capability token verification.
 *
 * Zero AWS dependencies: verification takes a public key (or a resolver) so
 * every service can verify tokens in-process, offline, and fast. Signing is
 * the token service's job (KMS); this module only ever sees public material.
 */

import { createPublicKey, KeyObject } from 'node:crypto'
import {
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload
} from 'jose'
import { AuthorizationError } from './errors'
import { parseScope, scopeCovers, type ParsedScope } from './scopes'

/** Signature algorithms the platform accepts (matches KMS SIGN_VERIFY key specs). */
export const ALLOWED_ALGORITHMS: readonly string[] = Object.freeze(['PS256', 'ES256'])

/** A public key as a Node KeyObject or an SPKI PEM string. */
export type PublicKeyInput = KeyObject | string

/** Static key: the caller already holds the verification key. */
export interface StaticKeySource {
  readonly publicKey: PublicKeyInput
}

/** Resolver: the caller maps the token's `kid` header to a key (e.g. cached KMS GetPublicKey output). */
export interface ResolverKeySource {
  readonly getPublicKey: (kid: string | undefined) => Promise<PublicKeyInput>
}

export type KeySource = StaticKeySource | ResolverKeySource

export interface VerifyTokenOptions {
  /** Leeway for clock skew when checking `exp`/`nbf`. Default 0 (strict). */
  readonly clockToleranceSeconds?: number
  /** When set, the token's `iss` claim must equal this value. */
  readonly issuer?: string
  /** Injection point for deterministic tests. Default: real time. */
  readonly now?: Date
}

/** A verified capability token's claims. */
export interface VerifiedToken {
  readonly sub: string
  readonly scopes: readonly string[]
  readonly iat: number
  readonly exp: number
  readonly jti: string
  readonly kid?: string
  /** Full verified payload for callers that need additional claims. */
  readonly claims: Readonly<JWTPayload>
}

/**
 * Verifies a capability JWT: signature, algorithm allowlist, expiry, and
 * claim shape (`sub`, `scopes`, `iat`, `exp`, `jti` are all required and
 * every scope must parse under the grammar).
 *
 * Throws {@link AuthorizationError} with a stable machine-readable code.
 */
export async function verifyToken(
  token: string,
  keySource: KeySource,
  options: VerifyTokenOptions = {}
): Promise<VerifiedToken> {
  const header = decodeHeader(token)

  if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) {
    throw new AuthorizationError(
      'ALG_NOT_ALLOWED',
      `Token algorithm "${String(header.alg)}" is not allowed`,
      `Sign tokens with one of: ${ALLOWED_ALGORITHMS.join(', ')}.`
    )
  }

  const key = await resolveKey(keySource, header.kid)
  const payload = await verifySignatureAndTimestamps(token, key, options)
  const claims = validateClaims(payload)

  return Object.freeze({
    ...claims,
    kid: header.kid,
    claims: Object.freeze({ ...payload })
  })
}

/**
 * Asserts the verified token grants `requiredScope` per the grammar's
 * matching semantics. Deny-by-default: throws {@link AuthorizationError}
 * (code `SCOPE_DENIED`) when no granted scope covers the requirement.
 */
export function requireScope(verified: VerifiedToken, requiredScope: string): void {
  const required: ParsedScope = parseScope(requiredScope)

  const isCovered = verified.scopes.some((granted) => scopeCovers(parseScope(granted), required))

  if (!isCovered) {
    throw new AuthorizationError(
      'SCOPE_DENIED',
      `Token for principal "${verified.sub}" does not grant required scope "${requiredScope}"`,
      `Request a token from the token service that includes "${requiredScope}" (subject to the principal's policy).`
    )
  }
}

interface DecodedHeader {
  readonly alg?: unknown
  readonly kid?: string
}

function decodeHeader(token: string): DecodedHeader {
  try {
    const header = decodeProtectedHeader(token)
    return { alg: header.alg, kid: typeof header.kid === 'string' ? header.kid : undefined }
  } catch {
    throw new AuthorizationError(
      'MALFORMED_TOKEN',
      'Token is not a well-formed JWT',
      'Present a compact-serialized JWT issued by the platform token service.'
    )
  }
}

async function resolveKey(keySource: KeySource, kid: string | undefined): Promise<KeyObject> {
  if ('publicKey' in keySource) {
    return toKeyObject(keySource.publicKey)
  }

  try {
    const resolved = await keySource.getPublicKey(kid)
    return toKeyObject(resolved)
  } catch (error: unknown) {
    throw new AuthorizationError(
      'KEY_RESOLUTION_FAILED',
      `Unable to resolve verification key for kid "${kid ?? '<none>'}": ${describeError(error)}`,
      'Ensure the token service signing key is published and the resolver can reach it.'
    )
  }
}

function toKeyObject(input: PublicKeyInput): KeyObject {
  if (typeof input !== 'string') {
    return input
  }

  try {
    return createPublicKey(input)
  } catch {
    throw new AuthorizationError(
      'KEY_RESOLUTION_FAILED',
      'Provided public key is not a valid SPKI PEM',
      'Provide the verification key as an SPKI PEM string or a Node KeyObject.'
    )
  }
}

async function verifySignatureAndTimestamps(
  token: string,
  key: KeyObject,
  options: VerifyTokenOptions
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [...ALLOWED_ALGORITHMS],
      clockTolerance: options.clockToleranceSeconds ?? 0,
      ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      ...(options.now !== undefined ? { currentDate: options.now } : {})
    })
    return payload
  } catch (error: unknown) {
    throw mapJoseError(error)
  }
}

function mapJoseError(error: unknown): AuthorizationError {
  if (error instanceof joseErrors.JWTExpired) {
    return new AuthorizationError(
      'TOKEN_EXPIRED',
      'Token has expired',
      'Request a fresh token from the token service; capability tokens are minutes-lived by design.'
    )
  }

  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return new AuthorizationError(
      'INVALID_CLAIMS',
      `Token claim validation failed: ${error.message}`,
      'Ensure the token was issued by the platform token service for this audience/issuer.'
    )
  }

  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return new AuthorizationError(
      'ALG_NOT_ALLOWED',
      'Token algorithm is not allowed',
      `Sign tokens with one of: ${ALLOWED_ALGORITHMS.join(', ')}.`
    )
  }

  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AuthorizationError(
      'INVALID_SIGNATURE',
      'Token signature verification failed',
      'Present a token signed by the platform signing key; do not modify token contents.'
    )
  }

  if (error instanceof joseErrors.JOSEError) {
    return new AuthorizationError(
      'MALFORMED_TOKEN',
      'Token is not a well-formed JWT',
      'Present a compact-serialized JWT issued by the platform token service.'
    )
  }

  return new AuthorizationError(
    'VERIFICATION_FAILED',
    `Token verification failed: ${describeError(error)}`,
    'Retry with a freshly issued token; report a platform bug if this persists.'
  )
}

interface RequiredClaims {
  readonly sub: string
  readonly scopes: readonly string[]
  readonly iat: number
  readonly exp: number
  readonly jti: string
}

function validateClaims(payload: JWTPayload): RequiredClaims {
  const { sub, exp, iat, jti } = payload

  if (typeof sub !== 'string' || sub.length === 0) {
    throw invalidClaims('"sub" must be a non-empty string')
  }

  if (typeof exp !== 'number' || typeof iat !== 'number') {
    throw invalidClaims('"exp" and "iat" are required numeric claims')
  }

  if (typeof jti !== 'string' || jti.length === 0) {
    throw invalidClaims('"jti" must be a non-empty string')
  }

  const scopes = validateScopesClaim(payload['scopes'])

  return { sub, scopes, iat, exp, jti }
}

function validateScopesClaim(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalidClaims('"scopes" must be an array of scope strings')
  }

  const scopes = value.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw invalidClaims('"scopes" must contain only strings')
    }

    try {
      parseScope(entry)
    } catch (error: unknown) {
      throw invalidClaims(`scope "${entry}" is invalid: ${describeError(error)}`)
    }

    return entry
  })

  return Object.freeze(scopes)
}

function invalidClaims(reason: string): AuthorizationError {
  return new AuthorizationError(
    'INVALID_CLAIMS',
    `Token claims are invalid: ${reason}`,
    'Tokens must carry sub, scopes, iat, exp, and jti as issued by the platform token service.'
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
