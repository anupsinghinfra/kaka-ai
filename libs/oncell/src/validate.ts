/**
 * Fail-fast input validation mirroring the OnCell API's documented limits —
 * bad input never leaves the process.
 */

import { OnCellInputError } from './errors'
import type { ExecInput } from './types'

export const MAX_CMD_LENGTH = 8192
export const MAX_TIMEOUT_MS = 600_000
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128

/** Asserts a required non-empty string argument. */
export function requireNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OnCellInputError(`${name} must be a non-empty string`)
  }
}

/** Validates exec input against the API limits (cmd 1..8192, timeout <= 600000, key 1..128). */
export function validateExecInput(input: ExecInput): void {
  if (typeof input.cmd !== 'string' || input.cmd.length < 1 || input.cmd.length > MAX_CMD_LENGTH) {
    throw new OnCellInputError(`cmd must be 1..${MAX_CMD_LENGTH} characters`)
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
      throw new OnCellInputError(`timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS}`)
    }
  }
  if (input.idempotencyKey !== undefined) {
    const keyLength = input.idempotencyKey.length
    if (keyLength < 1 || keyLength > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new OnCellInputError(`idempotencyKey must be 1..${MAX_IDEMPOTENCY_KEY_LENGTH} characters`)
    }
  }
}
