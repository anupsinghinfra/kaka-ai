/**
 * Wire types for the OnCell public API.
 *
 * Convention: client *inputs* are camelCase (mapped to snake_case on the
 * wire); *responses* are kept in wire form (snake_case) — the record you get
 * is the record the API returned, with an index signature for fields the API
 * adds over time.
 */

/** Fixed OnCell tiers — no free-form resource requests. */
export type CellTier = 'starter' | 'standard' | 'performance'

/**
 * A cell record as returned by the OnCell API. `cell_id` is server-derived
 * as `{developerId}--{customer_id}`.
 */
export interface CellRecord {
  readonly cell_id: string
  readonly status: string
  readonly customer_id?: string
  readonly tier?: string
  readonly host_id?: string | null
  readonly preview_url?: string | null
  readonly snapshot_key?: string | null
  readonly forked_from?: string | null
  readonly created_at?: string
  readonly [key: string]: unknown
}

/** A snapshot record as returned by POST /cells/{id}/snapshot. */
export interface SnapshotRecord {
  readonly snapshot_key: string
  readonly size_bytes?: number
  readonly created_at?: string
  readonly [key: string]: unknown
}

/** Result of an exec call, in wire form plus the client-derived `replayed`. */
export interface ExecResult {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly duration_ms: number
  /** True when the server answered from an idempotency-key replay (x-idempotent-replay). */
  readonly replayed: boolean
}

/** Input for POST /api/v1/cells. */
export interface CreateCellInput {
  readonly customerId: string
  readonly tier?: CellTier
  readonly snapshotKey?: string
}

/** Input for POST /api/v1/cells/{id}/fork. */
export interface ForkCellInput {
  readonly customerId: string
}

/** Input for POST /api/v1/cells/{id}/service (start the app service). */
export interface StartServiceInput {
  /** Command run inside the cell with PORT injected, e.g. "node src/server.js". */
  readonly cmd: string
  /** Extra environment variables for the service process. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * A service record as returned by the /service endpoints. Once running, the
 * cell's preview_url (https://{cell_id}.cells.oncell.ai) serves the app.
 */
export interface ServiceRecord {
  readonly running: boolean
  readonly port?: number
  readonly cmd?: string
  readonly [key: string]: unknown
}

/** Input for POST /api/v1/cells/{id}/exec. */
export interface ExecInput {
  /** Shell command, 1..8192 chars. */
  readonly cmd: string
  /** Caller timeout, <= 600000 ms. */
  readonly timeoutMs?: number
  /** 1..128 chars; enables server-side dedupe and safe client retry. */
  readonly idempotencyKey?: string
  /** When true, throws OnCellExecError (with stdout/stderr) on non-zero exit. */
  readonly expectSuccess?: boolean
}

/** Methods accepted by POST /api/v1/cells/{id}/request. */
export type CellRequestMethod =
  | 'write_file'
  | 'read_file'
  | 'list_files'
  | 'db_get'
  | 'db_set'
  | 'journal'
  | 'logs'
  | 'metrics'

/**
 * Expected shape of a read_file result. The public API does not pin these
 * request-helper shapes, so fields are optional and callers should narrow.
 */
export interface ReadFileResult {
  readonly content?: string
  readonly [key: string]: unknown
}

/** Expected shape of a list_files result (see ReadFileResult caveat). */
export interface ListFilesResult {
  readonly files?: readonly unknown[]
  readonly [key: string]: unknown
}

/** Expected shape of a db_get result (see ReadFileResult caveat). */
export interface KvGetResult {
  readonly value?: unknown
  readonly [key: string]: unknown
}

/** The typed OnCell client returned by createOnCellClient. */
export interface OnCellClient {
  /** POST /api/v1/cells — idempotent-by-identity: re-create returns the existing cell. */
  createCell(input: CreateCellInput): Promise<CellRecord>
  /** GET /api/v1/cells/{id}. */
  getCell(cellId: string): Promise<CellRecord>
  /** GET /api/v1/cells. */
  listCells(): Promise<readonly CellRecord[]>
  /** DELETE /api/v1/cells/{id}. */
  deleteCell(cellId: string): Promise<void>
  /** POST /api/v1/cells/{id}/pause. */
  pauseCell(cellId: string): Promise<CellRecord>
  /** POST /api/v1/cells/{id}/resume. */
  resumeCell(cellId: string): Promise<CellRecord>
  /** POST /api/v1/cells/{id}/exec. */
  exec(cellId: string, input: ExecInput): Promise<ExecResult>
  /** POST /api/v1/cells/{id}/snapshot. */
  snapshotCell(cellId: string): Promise<SnapshotRecord>
  /** GET /api/v1/cells/{id}/snapshots. */
  listSnapshots(cellId: string): Promise<readonly SnapshotRecord[]>
  /** POST /api/v1/cells/{id}/fork. */
  forkCell(cellId: string, input: ForkCellInput): Promise<CellRecord>
  /** POST /api/v1/cells/{id}/service — runs cmd in the cell with PORT injected. */
  startService(cellId: string, input: StartServiceInput): Promise<ServiceRecord>
  /** GET /api/v1/cells/{id}/service — 503 NO_APP_RUNNING until started. */
  getService(cellId: string): Promise<ServiceRecord>
  /** DELETE /api/v1/cells/{id}/service — 503 NO_APP_RUNNING when nothing runs. */
  stopService(cellId: string): Promise<void>
  /** Raw POST /api/v1/cells/{id}/request escape hatch. */
  request<T = unknown>(
    cellId: string,
    method: CellRequestMethod,
    params?: Readonly<Record<string, unknown>>
  ): Promise<T>
  /** request write_file. Full-content overwrite — safe to retry. */
  writeFile(cellId: string, path: string, content: string): Promise<unknown>
  /** request read_file. */
  readFile(cellId: string, path: string): Promise<ReadFileResult>
  /** request list_files. */
  listFiles(cellId: string, path?: string): Promise<ListFilesResult>
  /** request db_get. */
  kvGet(cellId: string, key: string): Promise<KvGetResult>
  /** request db_set. Absolute value write — safe to retry. */
  kvSet(cellId: string, key: string, value: unknown): Promise<unknown>
  /** request journal. */
  journal(cellId: string): Promise<unknown>
  /** request logs. */
  logs(cellId: string, lines?: number): Promise<unknown>
  /** request metrics. */
  metrics(cellId: string): Promise<unknown>
}
