/**
 * Request parsing and validation for `POST /tokens`.
 * All input is untrusted: schema-validate before any business logic runs.
 */

import { isValidScope, MAX_SCOPE_LENGTH } from '@platform/authorizer'
import { z } from 'zod'
import { MAX_TTL_SECONDS } from './config'
import { TokenServiceError } from './errors'

/** Bound on scopes per token — enough for any agent role, small enough to audit. */
export const MAX_SCOPES_PER_TOKEN = 50

/** Principal identifiers: bounded, printable, no whitespace or control chars. */
const PRINCIPAL_ID_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/

const issueTokenRequestSchema = z
  .object({
    principalId: z
      .string()
      .regex(PRINCIPAL_ID_PATTERN, 'principalId must be 1-128 chars of [a-zA-Z0-9._:/-]'),
    scopes: z
      .array(z.string().min(1).max(MAX_SCOPE_LENGTH))
      .min(1, 'at least one scope is required')
      .max(MAX_SCOPES_PER_TOKEN, `at most ${MAX_SCOPES_PER_TOKEN} scopes per token`),
    ttlSeconds: z.number().int('ttlSeconds must be an integer').positive('ttlSeconds must be positive').optional(),
    parentToken: z.string().min(1).max(16_384).optional()
  })
  .strict()

export type IssueTokenRequest = z.infer<typeof issueTokenRequestSchema>

/**
 * Parses the raw HTTP body into a validated issuance request.
 * Throws {@link TokenServiceError} with a machine-readable code on any defect.
 */
export function parseIssueTokenRequest(body: string | undefined, isBase64Encoded: boolean): IssueTokenRequest {
  if (body === undefined || body.length === 0) {
    throw invalidRequest('Request body is required')
  }

  const decoded = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(decoded)
  } catch {
    throw invalidRequest('Request body is not valid JSON')
  }

  const result = issueTokenRequestSchema.safeParse(parsedJson)

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw invalidRequest(`Request validation failed — ${detail}`)
  }

  const request = result.data
  validateRequestedScopes(request.scopes)
  validateTtl(request.ttlSeconds)

  return request
}

function validateRequestedScopes(scopes: readonly string[]): void {
  const invalidScopes = scopes.filter((scope) => !isValidScope(scope))

  if (invalidScopes.length > 0) {
    throw new TokenServiceError(
      'INVALID_SCOPE',
      400,
      `Scopes do not conform to the scope grammar: ${invalidScopes.join(', ')}`,
      'Use "primitive:verb" or "primitive:verb:resource" with lowercase segments; "*" only as a full segment. See contracts/tokens/scope-grammar.md.'
    )
  }
}

function validateTtl(ttlSeconds: number | undefined): void {
  if (ttlSeconds !== undefined && ttlSeconds > MAX_TTL_SECONDS) {
    throw new TokenServiceError(
      'INVALID_TTL',
      400,
      `Requested TTL of ${ttlSeconds}s exceeds the maximum of ${MAX_TTL_SECONDS}s`,
      `Request a TTL of at most ${MAX_TTL_SECONDS} seconds; re-request tokens instead of holding long-lived ones.`
    )
  }
}

function invalidRequest(message: string): TokenServiceError {
  return new TokenServiceError(
    'INVALID_REQUEST',
    400,
    message,
    'Send JSON: { "principalId": string, "scopes": string[], "ttlSeconds"?: number, "parentToken"?: string }.'
  )
}
