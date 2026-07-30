/**
 * Machine-readable errors for the authorizer library.
 *
 * Every failure carries a stable `code` plus a `remediation` hint so agents
 * (not just humans) can react to denials — see EXECUTION.md §1 ("an unscoped
 * call gets a machine-readable 403").
 */

/** Stable error codes for token verification and scope checks. */
export type AuthorizationErrorCode =
  | 'MALFORMED_TOKEN'
  | 'ALG_NOT_ALLOWED'
  | 'INVALID_SIGNATURE'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CLAIMS'
  | 'KEY_RESOLUTION_FAILED'
  | 'SCOPE_DENIED'
  | 'VERIFICATION_FAILED'

/** JSON shape of a serialized authorization error. */
export interface AuthorizationErrorBody {
  readonly error: {
    readonly code: AuthorizationErrorCode
    readonly message: string
    readonly remediation: string
  }
}

/** Thrown when a token fails verification or lacks a required scope. */
export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode
  readonly remediation: string

  constructor(code: AuthorizationErrorCode, message: string, remediation: string) {
    super(message)
    this.name = 'AuthorizationError'
    this.code = code
    this.remediation = remediation
  }

  /** Machine-readable body suitable for a 401/403 response. */
  toJSON(): AuthorizationErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        remediation: this.remediation
      }
    }
  }
}

/** Thrown when a scope string does not conform to the scope grammar. */
export class ScopeGrammarError extends Error {
  readonly code = 'INVALID_SCOPE' as const
  readonly scope: string

  constructor(scope: string, reason: string) {
    super(`Invalid scope "${scope}": ${reason}`)
    this.name = 'ScopeGrammarError'
    this.scope = scope
  }
}
