/**
 * API route helpers: the machine-readable error envelope
 * {error: {code, message, remediation}} and mapping of library errors —
 * OnCellApiError keeps its upstream HTTP status.
 */

import {
  OnCellApiError,
  OnCellConfigError,
  OnCellExecError,
  OnCellInputError
} from '@platform/oncell'
import { ZodError } from 'zod'

export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly remediation?: string
  }
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  remediation?: string
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(remediation !== undefined ? { remediation } : {}) }
  }
  return Response.json(body, { status })
}

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/** Maps thrown errors to the error envelope; OnCell statuses pass through. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof OnCellApiError) {
    // status 0 means a transport-level failure reaching OnCell.
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502
    return jsonError(error.code ?? 'ONCELL_API_ERROR', error.message, status, error.remediation)
  }
  if (error instanceof OnCellConfigError) {
    return jsonError(
      'ONCELL_NOT_CONFIGURED',
      error.message,
      503,
      'Set ONCELL_API_KEY in the repo-root .env (real env vars win).'
    )
  }
  if (error instanceof OnCellInputError) {
    return jsonError('INVALID_INPUT', error.message, 400)
  }
  if (error instanceof OnCellExecError) {
    return jsonError('EXEC_FAILED', error.message, 502)
  }
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ')
    return jsonError('VALIDATION_ERROR', message, 400)
  }
  const message = error instanceof Error ? error.message : String(error)
  return jsonError('INTERNAL_ERROR', message, 500)
}

/** Parses a JSON request body, returning undefined for malformed JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
