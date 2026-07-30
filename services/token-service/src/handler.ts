/**
 * `POST /tokens` — capability token issuance.
 *
 * Order of enforcement (all deny-by-default):
 *   1. schema + scope-grammar + TTL validation (400),
 *   2. principal policy exists in DynamoDB (403 POLICY_NOT_FOUND),
 *   3. requested scopes ⊆ policy.allowedScopes (403 SCOPE_NOT_ALLOWED),
 *   4. if a parent token is presented: it verifies (401 INVALID_PARENT_TOKEN)
 *      and requested scopes ⊆ parent scopes (403 ATTENUATION_VIOLATION).
 *
 * Policy and attenuation are both enforced when a parent token is present —
 * delegation can only ever narrow, never bypass, the principal's policy.
 */

import { randomUUID } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { isScopeSubset, verifyToken, type VerifiedToken } from '@platform/authorizer'
import { TOKEN_ISSUER, type ServiceConfig } from './config'
import { internalError, TokenServiceError } from './errors'
import type { JwtSigner } from './kms-signer'
import type { Logger } from './logging'
import type { PolicyRepository } from './policy-store'
import { parseIssueTokenRequest, type IssueTokenRequest } from './request'

/** Clock-skew leeway when verifying parent tokens (seconds). */
const PARENT_TOKEN_CLOCK_TOLERANCE_SECONDS = 5

export interface IssueTokenResponseBody {
  readonly token: string
  readonly tokenType: 'Bearer'
  readonly expiresIn: number
  readonly expiresAt: string
  readonly jti: string
  readonly scopes: readonly string[]
}

export interface HandlerDependencies {
  readonly policies: PolicyRepository
  readonly signer: JwtSigner
  /** Verification key for parent tokens (cached KMS GetPublicKey in prod). */
  readonly getVerificationKey: () => Promise<KeyObject>
  readonly config: ServiceConfig
  readonly logger: Logger
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

export type IssueTokenHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

export function createIssueTokenHandler(deps: HandlerDependencies): IssueTokenHandler {
  const clock = deps.now ?? ((): Date => new Date())

  return async (event) => {
    const log = deps.logger.child({ requestId: event.requestContext?.requestId })

    try {
      const request = parseIssueTokenRequest(event.body, event.isBase64Encoded ?? false)
      const response = await issueToken(request, deps, clock, log)

      return jsonResponse(201, response)
    } catch (error: unknown) {
      if (error instanceof TokenServiceError) {
        log.warn({ code: error.code, statusCode: error.statusCode, reason: error.message }, 'token request denied')
        return jsonResponse(error.statusCode, error.toBody())
      }

      log.error({ err: error }, 'unhandled error during token issuance')
      const fallback = internalError()
      return jsonResponse(fallback.statusCode, fallback.toBody())
    }
  }
}

async function issueToken(
  request: IssueTokenRequest,
  deps: HandlerDependencies,
  clock: () => Date,
  log: Logger
): Promise<IssueTokenResponseBody> {
  const { principalId, scopes, parentToken } = request
  const ttlSeconds = request.ttlSeconds ?? deps.config.defaultTtlSeconds

  await enforcePolicy(principalId, scopes, deps.policies)

  if (parentToken !== undefined) {
    await enforceAttenuation(parentToken, scopes, deps, clock)
  }

  const issuedAt = Math.floor(clock().getTime() / 1000)
  const expiresAt = issuedAt + ttlSeconds
  const jti = randomUUID()

  const claims = Object.freeze({
    iss: TOKEN_ISSUER,
    sub: principalId,
    scopes,
    iat: issuedAt,
    exp: expiresAt,
    jti
  })

  const token = await deps.signer.sign(claims)

  log.info({ principalId, scopes, ttlSeconds, jti, attenuatedFromParent: parentToken !== undefined }, 'token issued')

  return {
    token,
    tokenType: 'Bearer',
    expiresIn: ttlSeconds,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    jti,
    scopes
  }
}

async function enforcePolicy(
  principalId: string,
  scopes: readonly string[],
  policies: PolicyRepository
): Promise<void> {
  const policy = await policies.findByPrincipalId(principalId)

  if (policy === null) {
    throw new TokenServiceError(
      'POLICY_NOT_FOUND',
      403,
      `No policy document exists for principal "${principalId}" — deny by default`,
      'Register a policy document (principalId, allowedScopes[]) in the policies table before requesting tokens.'
    )
  }

  const deniedScopes = scopes.filter((scope) => !isScopeSubset([scope], policy.allowedScopes))

  if (deniedScopes.length > 0) {
    throw new TokenServiceError(
      'SCOPE_NOT_ALLOWED',
      403,
      `Requested scopes are not allowed by the policy for principal "${principalId}": ${deniedScopes.join(', ')}`,
      'Request only scopes covered by the principal policy, or update the policy document for this principal.'
    )
  }
}

async function enforceAttenuation(
  parentToken: string,
  scopes: readonly string[],
  deps: HandlerDependencies,
  clock: () => Date
): Promise<void> {
  let parent: VerifiedToken

  try {
    parent = await verifyToken(
      parentToken,
      { getPublicKey: () => deps.getVerificationKey() },
      {
        issuer: TOKEN_ISSUER,
        clockToleranceSeconds: PARENT_TOKEN_CLOCK_TOLERANCE_SECONDS,
        now: clock()
      }
    )
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'verification failed'
    throw new TokenServiceError(
      'INVALID_PARENT_TOKEN',
      401,
      `Parent token is not valid: ${reason}`,
      'Present a live, unmodified token issued by this service as parentToken, or omit it.'
    )
  }

  const escalatedScopes = scopes.filter((scope) => !isScopeSubset([scope], parent.scopes))

  if (escalatedScopes.length > 0) {
    throw new TokenServiceError(
      'ATTENUATION_VIOLATION',
      403,
      `Requested scopes exceed the parent token's scopes: ${escalatedScopes.join(', ')}`,
      'A child token may only narrow the parent: request a subset of the parent token scopes.'
    )
  }
}

function jsonResponse(statusCode: number, body: object): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  }
}
