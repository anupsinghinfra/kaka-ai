/**
 * Tiny browser-side fetch helper: unwraps the API's machine-readable error
 * envelope into thrown Errors with a friendly message.
 */

export class ApiError extends Error {
  readonly code: string
  readonly remediation?: string

  constructor(code: string, message: string, remediation?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.remediation = remediation
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; remediation?: string }
}

export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    let envelope: ErrorEnvelope = {}
    try {
      envelope = (await response.json()) as ErrorEnvelope
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    throw new ApiError(
      envelope.error?.code ?? `HTTP_${response.status}`,
      envelope.error?.message ?? `request failed with HTTP ${response.status}`,
      envelope.error?.remediation
    )
  }
  return (await response.json()) as T
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.remediation !== undefined ? `${error.message} — ${error.remediation}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}
