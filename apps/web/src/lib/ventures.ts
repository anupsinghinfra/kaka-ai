/**
 * Venture operations — the composition layer between the local registry and
 * the OnCell public API. Route handlers stay thin by delegating here.
 */

import type { CellRecord } from '@platform/oncell'
import { getOnCell } from './oncell'
import {
  addVenture,
  getVenture,
  recordSnapshot,
  removeVenture,
  type SnapshotEntry,
  type Venture
} from './registry'
import { ventureCustomerId } from './validation'

/** In-cell marker file identifying the venture. */
export const VENTURE_FILE_PATH = '.kaka/venture.json'
/** In-cell KV key holding the venture name. */
export const VENTURE_NAME_KEY = 'venture:name'

export type CellStatus = string | 'unknown'

export interface VentureWithStatus extends Venture {
  readonly status: CellStatus
}

/** Fetches a cell's live status, tolerating errors as "unknown". */
export async function fetchCellStatus(cellId: string): Promise<CellStatus> {
  try {
    const cell = await getOnCell().getCell(cellId)
    return typeof cell.status === 'string' && cell.status.length > 0 ? cell.status : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Attaches live statuses to registry ventures (parallel, error-tolerant). */
export async function withStatuses(
  ventures: readonly Venture[]
): Promise<readonly VentureWithStatus[]> {
  return Promise.all(
    ventures.map(async (venture) => ({
      ...venture,
      status: await fetchCellStatus(venture.cellId)
    }))
  )
}

function ventureFileContent(name: string, idea: string | undefined, createdAt: string): string {
  return `${JSON.stringify({ name, idea: idea ?? null, createdAt }, null, 2)}\n`
}

/** Seeds the in-cell identity: .kaka/venture.json + kv venture:name. */
async function seedCellIdentity(
  cellId: string,
  name: string,
  idea: string | undefined,
  createdAt: string
): Promise<void> {
  const client = getOnCell()
  await client.writeFile(cellId, VENTURE_FILE_PATH, ventureFileContent(name, idea, createdAt))
  await client.kvSet(cellId, VENTURE_NAME_KEY, name)
}

/** Creates the OnCell cell, seeds identity, and registers the venture. */
export async function createVenture(name: string, idea: string | undefined): Promise<Venture> {
  if (getVenture(name) !== undefined) {
    throw new VentureConflictError(name)
  }
  const client = getOnCell()
  const customerId = ventureCustomerId(name)
  const cell = await client.createCell({ customerId })
  const createdAt = new Date().toISOString()
  await seedCellIdentity(cell.cell_id, name, idea, createdAt)
  const venture: Venture = {
    name,
    cellId: cell.cell_id,
    customerId,
    ...(idea !== undefined && idea.length > 0 ? { idea } : {}),
    createdAt,
    snapshots: []
  }
  return addVenture(venture)
}

/** Forks a venture's cell into a new venture (code + files + state). */
export async function forkVenture(sourceName: string, newName: string): Promise<Venture> {
  const source = getVenture(sourceName)
  if (source === undefined) {
    throw new VentureNotFoundError(sourceName)
  }
  if (getVenture(newName) !== undefined) {
    throw new VentureConflictError(newName)
  }
  const client = getOnCell()
  const customerId = ventureCustomerId(newName)
  const fork: CellRecord = await client.forkCell(source.cellId, { customerId })
  const createdAt = new Date().toISOString()
  // Re-seed identity in the fork so the copied cell knows its new name.
  await seedCellIdentity(fork.cell_id, newName, source.idea, createdAt)
  const venture: Venture = {
    name: newName,
    cellId: fork.cell_id,
    customerId,
    ...(source.idea !== undefined ? { idea: source.idea } : {}),
    createdAt,
    forkedFrom: sourceName,
    snapshots: []
  }
  return addVenture(venture)
}

/** Snapshots the cell and records the key in the registry. */
export async function snapshotVenture(name: string): Promise<SnapshotEntry> {
  const venture = getVenture(name)
  if (venture === undefined) {
    throw new VentureNotFoundError(name)
  }
  const snapshot = await getOnCell().snapshotCell(venture.cellId)
  const entry: SnapshotEntry = {
    key: snapshot.snapshot_key,
    at: typeof snapshot.created_at === 'string' ? snapshot.created_at : new Date().toISOString()
  }
  recordSnapshot(name, entry)
  return entry
}

/**
 * Deletes a venture. Unless keepRemote is set, the OnCell cell is deleted
 * too (a 404 upstream is tolerated — the registry entry still goes away).
 */
export async function deleteVenture(name: string, keepRemote: boolean): Promise<void> {
  const venture = getVenture(name)
  if (venture === undefined) {
    throw new VentureNotFoundError(name)
  }
  if (!keepRemote) {
    try {
      await getOnCell().deleteCell(venture.cellId)
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error
      }
    }
  }
  removeVenture(name)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  )
}

export class VentureNotFoundError extends Error {
  constructor(name: string) {
    super(`venture "${name}" not found`)
    this.name = 'VentureNotFoundError'
  }
}

export class VentureConflictError extends Error {
  constructor(name: string) {
    super(`venture "${name}" already exists`)
    this.name = 'VentureConflictError'
  }
}
