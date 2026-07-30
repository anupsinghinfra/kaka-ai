/**
 * Machine-readable errors for the token service API.
 * Response body shape: `{ error: { code, message, remediation } }`.
 */

export type TokenServiceErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_SCOPE'
  | 'INVALID_TTL'
  | 'INVALID_PARENT_TOKEN'
  | 'POLICY_NOT_FOUND'
  | 'POLICY_INVALID'
  | 'SCOPE_NOT_ALLOWED'
  | 'ATTENUATION_VIOLATION'
  | 'INTERNAL_ERROR'

export interface TokenServiceErrorBody {
  readonly error: {
    readonly code: TokenServiceErrorCode
    readonly message: string
    readonly remediation: string
  }
}

export class TokenServiceError extends Error {
  readonly code: TokenServiceErrorCode
  readonly statusCode: number
  readonly remediation: string

  constructor(code: TokenServiceErrorCode, statusCode: number, message: string, remediation: string) {
    super(message)
    this.name = 'TokenServiceError'
    this.code = code
    this.statusCode = statusCode
    this.remediation = remediation
  }

  toBody(): TokenServiceErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        remediation: this.remediation
      }
    }
  }
}

/** Fallback for unexpected failures — never leaks internals to the caller. */
export function internalError(): TokenServiceError {
  return new TokenServiceError(
    'INTERNAL_ERROR',
    500,
    'Token issuance failed due to an internal error',
    'Retry the request; if the failure persists, check token-service logs for this requestId.'
  )
}
