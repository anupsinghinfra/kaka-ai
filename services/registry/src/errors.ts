/**
 * Machine-readable errors for the registry API.
 * Response body shape: `{ error: { code, message, remediation, details? } }`.
 */

export type RegistryErrorCode =
  | 'MISSING_TOKEN'
  | 'INVALID_REQUEST'
  | 'INVALID_MANIFEST'
  | 'ROUTE_NOT_FOUND'
  | 'VENTURE_NOT_FOUND'
  | 'VENTURE_EXISTS'
  | 'VENTURE_DELETED'
  | 'VERSION_CONFLICT'
  | 'INTERNAL_ERROR'

/** One schema-validation failure, pointing at the offending manifest path. */
export interface RegistryErrorDetail {
  readonly path: string
  readonly message: string
}

export interface RegistryErrorBody {
  readonly error: {
    readonly code: RegistryErrorCode
    readonly message: string
    readonly remediation: string
    readonly details?: readonly RegistryErrorDetail[]
  }
}

export class RegistryError extends Error {
  readonly code: RegistryErrorCode
  readonly statusCode: number
  readonly remediation: string
  readonly details?: readonly RegistryErrorDetail[]

  constructor(
    code: RegistryErrorCode,
    statusCode: number,
    message: string,
    remediation: string,
    details?: readonly RegistryErrorDetail[]
  ) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    this.statusCode = statusCode
    this.remediation = remediation
    if (details !== undefined) {
      this.details = details
    }
  }

  toBody(): RegistryErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        remediation: this.remediation,
        ...(this.details !== undefined ? { details: this.details } : {})
      }
    }
  }
}

/** Fallback for unexpected failures — never leaks internals to the caller. */
export function internalError(): RegistryError {
  return new RegistryError(
    'INTERNAL_ERROR',
    500,
    'Registry request failed due to an internal error',
    'Retry the request; if the failure persists, check registry logs for this requestId.'
  )
}

export function ventureNotFound(ventureId: string): RegistryError {
  return new RegistryError(
    'VENTURE_NOT_FOUND',
    404,
    `No venture exists with id "${ventureId}"`,
    'Check the venture id; list ventures with GET /ventures to discover valid ids.'
  )
}
