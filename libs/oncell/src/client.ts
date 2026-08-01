/**
 * createOnCellClient — the typed entry point for the OnCell public API.
 *
 * Configuration comes from options first, then env (ONCELL_API_KEY /
 * ONCELL_API_URL); construction throws fast when no API key is available.
 */

import type { Logger } from 'pino'
import { createAgentApi } from './agent-api'
import { createAgentRunsApi } from './agent-runs'
import { OnCellApiError, OnCellConfigError, OnCellExecError } from './errors'
import {
  DEFAULT_RETRY_BACKOFF_MS,
  sendRequest,
  type FetchLike,
  type HttpConfig
} from './http'
import { logger as defaultLogger } from './logger'
import { createRequestApi } from './request-helpers'
import type {
  CellRecord,
  CreateCellInput,
  ExecInput,
  ExecResult,
  ForkCellInput,
  OnCellClient,
  ServiceRecord,
  SnapshotRecord,
  StartServiceInput
} from './types'
import { requireNonEmptyString, validateExecInput } from './validate'

/** Default public API endpoint. */
export const DEFAULT_ONCELL_API_URL = 'https://api.oncell.ai'

/** Options for createOnCellClient. All optional; env fills the gaps. */
export interface OnCellClientOptions {
  /** Defaults to env ONCELL_API_KEY. Construction throws if neither is set. */
  readonly apiKey?: string
  /** Defaults to env ONCELL_API_URL, then https://api.oncell.ai. */
  readonly baseUrl?: string
  /** Injectable fetch (tests); defaults to the global fetch. */
  readonly fetchImpl?: FetchLike
  /** Backoff before the single 502/503 retry. */
  readonly retryBackoffMs?: number
  /** Custom pino logger; the library default is silent. */
  readonly logger?: Logger
}

/** Exec result as it appears on the wire (before `replayed` is attached). */
type WireExecResult = Omit<ExecResult, 'replayed'>

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function cellPath(cellId: string, suffix = ''): string {
  return `/api/v1/cells/${encodeURIComponent(cellId)}${suffix}`
}

/** Accepts either a bare array or an `{[key]: [...]}` envelope for list endpoints. */
function toRecordArray<T>(data: unknown, key: string): readonly T[] {
  if (Array.isArray(data)) {
    return data as readonly T[]
  }
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>)[key]
    if (Array.isArray(nested)) {
      return nested as readonly T[]
    }
  }
  throw new OnCellApiError({
    status: 200,
    code: 'UNEXPECTED_RESPONSE',
    message: `expected an array (or {${key}: [...]}) from the ${key} list endpoint`
  })
}

/** Creates a typed OnCell client. Throws OnCellConfigError if no API key is available. */
export function createOnCellClient(options: OnCellClientOptions = {}): OnCellClient {
  const apiKey = options.apiKey ?? process.env.ONCELL_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new OnCellConfigError(
      'OnCell API key missing: pass options.apiKey or set ONCELL_API_KEY'
    )
  }

  const config: HttpConfig = {
    baseUrl: stripTrailingSlash(options.baseUrl ?? process.env.ONCELL_API_URL ?? DEFAULT_ONCELL_API_URL),
    apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    retryBackoffMs: options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
    logger: options.logger ?? defaultLogger
  }

  async function createCell(input: CreateCellInput): Promise<CellRecord> {
    requireNonEmptyString(input.customerId, 'customerId')
    const body = {
      customer_id: input.customerId,
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.snapshotKey !== undefined ? { snapshot_key: input.snapshotKey } : {})
    }
    // Idempotent-by-identity: re-create returns the existing cell record.
    const result = await sendRequest<CellRecord>(config, {
      method: 'POST',
      path: '/api/v1/cells',
      body,
      idempotent: true
    })
    return result.data
  }

  async function getCell(cellId: string): Promise<CellRecord> {
    requireNonEmptyString(cellId, 'cellId')
    const result = await sendRequest<CellRecord>(config, {
      method: 'GET',
      path: cellPath(cellId),
      idempotent: true
    })
    return result.data
  }

  async function listCells(): Promise<readonly CellRecord[]> {
    const result = await sendRequest<unknown>(config, {
      method: 'GET',
      path: '/api/v1/cells',
      idempotent: true
    })
    return toRecordArray<CellRecord>(result.data, 'cells')
  }

  async function deleteCell(cellId: string): Promise<void> {
    requireNonEmptyString(cellId, 'cellId')
    await sendRequest<unknown>(config, {
      method: 'DELETE',
      path: cellPath(cellId),
      idempotent: true
    })
  }

  async function lifecycle(cellId: string, verb: 'pause' | 'resume'): Promise<CellRecord> {
    requireNonEmptyString(cellId, 'cellId')
    const result = await sendRequest<CellRecord>(config, {
      method: 'POST',
      path: cellPath(cellId, `/${verb}`),
      idempotent: true
    })
    return result.data
  }

  async function exec(cellId: string, input: ExecInput): Promise<ExecResult> {
    requireNonEmptyString(cellId, 'cellId')
    validateExecInput(input)
    const body = {
      cmd: input.cmd,
      ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotency_key: input.idempotencyKey } : {})
    }
    const result = await sendRequest<WireExecResult>(config, {
      method: 'POST',
      path: cellPath(cellId, '/exec'),
      body,
      // Only retryable when the server can dedupe the command.
      idempotent: input.idempotencyKey !== undefined
    })
    const execResult: ExecResult = { ...result.data, replayed: result.idempotentReplay }
    if (input.expectSuccess === true && execResult.exit_code !== 0) {
      throw new OnCellExecError(cellId, input.cmd, execResult.exit_code, execResult.stdout, execResult.stderr)
    }
    return execResult
  }

  async function snapshotCell(cellId: string): Promise<SnapshotRecord> {
    requireNonEmptyString(cellId, 'cellId')
    // Creates a new snapshot each call — never retried.
    const result = await sendRequest<SnapshotRecord>(config, {
      method: 'POST',
      path: cellPath(cellId, '/snapshot'),
      idempotent: false
    })
    return result.data
  }

  async function listSnapshots(cellId: string): Promise<readonly SnapshotRecord[]> {
    requireNonEmptyString(cellId, 'cellId')
    const result = await sendRequest<unknown>(config, {
      method: 'GET',
      path: cellPath(cellId, '/snapshots'),
      idempotent: true
    })
    return toRecordArray<SnapshotRecord>(result.data, 'snapshots')
  }

  async function forkCell(cellId: string, input: ForkCellInput): Promise<CellRecord> {
    requireNonEmptyString(cellId, 'cellId')
    requireNonEmptyString(input.customerId, 'customerId')
    // Fork targets a server-derived identity ({developerId}--{customer_id}),
    // so like create it is idempotent-by-identity and safe to retry.
    const result = await sendRequest<CellRecord>(config, {
      method: 'POST',
      path: cellPath(cellId, '/fork'),
      body: { customer_id: input.customerId },
      idempotent: true
    })
    return result.data
  }

  // The /service endpoints use 503 semantically (NO_APP_RUNNING), so the
  // transport's transient-503 retry must never apply to them — every call
  // below is idempotent: false.
  async function startService(cellId: string, input: StartServiceInput): Promise<ServiceRecord> {
    requireNonEmptyString(cellId, 'cellId')
    requireNonEmptyString(input.cmd, 'cmd')
    const body = {
      cmd: input.cmd,
      ...(input.env !== undefined ? { env: input.env } : {})
    }
    const result = await sendRequest<ServiceRecord>(config, {
      method: 'POST',
      path: cellPath(cellId, '/service'),
      body,
      idempotent: false
    })
    return result.data
  }

  async function getService(cellId: string): Promise<ServiceRecord> {
    requireNonEmptyString(cellId, 'cellId')
    const result = await sendRequest<ServiceRecord>(config, {
      method: 'GET',
      path: cellPath(cellId, '/service'),
      idempotent: false
    })
    return result.data
  }

  async function stopService(cellId: string): Promise<void> {
    requireNonEmptyString(cellId, 'cellId')
    await sendRequest<unknown>(config, {
      method: 'DELETE',
      path: cellPath(cellId, '/service'),
      idempotent: false
    })
  }

  return Object.freeze({
    createCell,
    getCell,
    listCells,
    deleteCell,
    pauseCell: (cellId: string) => lifecycle(cellId, 'pause'),
    resumeCell: (cellId: string) => lifecycle(cellId, 'resume'),
    exec,
    snapshotCell,
    listSnapshots,
    forkCell,
    startService,
    getService,
    stopService,
    ...createRequestApi(config),
    ...createAgentApi(config),
    ...createAgentRunsApi(config)
  })
}
