/**
 * Typed errors for the OnCell client.
 *
 * The API returns two error body shapes — legacy `{error: string}` and newer
 * `{error: {code, message, remediation}}` — both are normalized into
 * OnCellApiError so callers never branch on wire shape.
 */

const MAX_RAW_BODY_IN_MESSAGE = 200

/** Thrown when the client is constructed without an API key. */
export class OnCellConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnCellConfigError'
  }
}

/** Thrown when a call is made with invalid input (fails fast, no network). */
export class OnCellInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnCellInputError'
  }
}

/** Fields carried by a normalized OnCell API error. */
export interface OnCellApiErrorFields {
  /** HTTP status; 0 for transport-level (network) failures. */
  readonly status: number
  readonly message: string
  readonly code?: string
  readonly remediation?: string
}

/** Normalized OnCell API error (covers both wire error shapes). */
export class OnCellApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly remediation?: string

  constructor(fields: OnCellApiErrorFields) {
    super(fields.message)
    this.name = 'OnCellApiError'
    this.status = fields.status
    this.code = fields.code
    this.remediation = fields.remediation
  }
}

/** Thrown by exec({expectSuccess: true}) on non-zero exit, with output context. */
export class OnCellExecError extends Error {
  readonly cellId: string
  readonly cmd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(cellId: string, cmd: string, exitCode: number, stdout: string, stderr: string) {
    super(
      `exec failed in cell ${cellId} (exit ${exitCode}): ${cmd}\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`
    )
    this.name = 'OnCellExecError'
    this.cellId = cellId
    this.cmd = cmd
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes a non-2xx response body into an OnCellApiError. Handles
 * `{error: string}`, `{error: {code, message, remediation}}`, and non-JSON
 * bodies (falls back to the raw text, truncated).
 */
export function parseApiError(status: number, rawBody: string): OnCellApiError {
  let parsed: unknown
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : undefined
  } catch {
    parsed = undefined
  }

  if (isRecord(parsed)) {
    const errorField = parsed['error']
    if (typeof errorField === 'string') {
      return new OnCellApiError({ status, message: errorField })
    }
    if (isRecord(errorField)) {
      const message = typeof errorField['message'] === 'string' ? errorField['message'] : `HTTP ${status}`
      const code = typeof errorField['code'] === 'string' ? errorField['code'] : undefined
      const remediation =
        typeof errorField['remediation'] === 'string' ? errorField['remediation'] : undefined
      return new OnCellApiError({ status, message, code, remediation })
    }
  }

  const fallback = rawBody.trim().slice(0, MAX_RAW_BODY_IN_MESSAGE)
  return new OnCellApiError({
    status,
    message: fallback.length > 0 ? `HTTP ${status}: ${fallback}` : `HTTP ${status}`
  })
}
