/**
 * @platform/oncell — typed client for the OnCell public API.
 *
 * kaka is a customer of OnCell (oncell.ai) and consumes ONLY this public
 * surface: cell lifecycle (create/get/list/delete/pause/resume), exec with
 * idempotency keys, snapshot/fork, and the in-cell request helpers
 * (files, KV, journal, logs, metrics).
 */

export {
  createOnCellClient,
  DEFAULT_ONCELL_API_URL,
  type OnCellClientOptions
} from './client'
export {
  OnCellApiError,
  OnCellConfigError,
  OnCellExecError,
  OnCellInputError,
  parseApiError,
  type OnCellApiErrorFields
} from './errors'
export {
  DEFAULT_RETRY_BACKOFF_MS,
  type FetchLike,
  type FetchRequestInit,
  type FetchResponseLike
} from './http'
export type { RequestApi } from './request-helpers'
export {
  type CellRecord,
  type CellRequestMethod,
  type CellTier,
  type CreateCellInput,
  type ExecInput,
  type ExecResult,
  type ForkCellInput,
  type KvGetResult,
  type ListFilesResult,
  type OnCellClient,
  type ReadFileResult,
  type ServiceRecord,
  type SnapshotRecord,
  type StartServiceInput
} from './types'
export {
  MAX_CMD_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_TIMEOUT_MS
} from './validate'

/** Name of this library (stable identifier for logs/diagnostics). */
export const ONCELL_LIBRARY_NAME: string = '@platform/oncell'
