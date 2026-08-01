/**
 * Idea operations — the composition layer between the local registry and
 * the OnCell public API. Route handlers stay thin by delegating here.
 */

import type { CellRecord } from '@platform/oncell'
import { IDEA_FILE_PATH } from './builder-agent/agent-def'
import { deployBuilderAgent } from './builder-agent/deploy'
import { builderMode } from './builder-agent/mode'
import { getOnCell } from './oncell'
import {
  addIdea,
  getIdea,
  recordSnapshot,
  removeIdea,
  type Idea,
  type SnapshotEntry
} from './registry'
import { ideaCustomerId } from './validation'

/** In-cell marker file identifying the idea (defined with the agent protocol). */
export { IDEA_FILE_PATH } from './builder-agent/agent-def'
/** In-cell KV key holding the idea name. */
export const IDEA_NAME_KEY = 'idea:name'

export type CellStatus = string | 'unknown'

export interface IdeaWithStatus extends Idea {
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

/** Attaches live statuses to registry ideas (parallel, error-tolerant). */
export async function withStatuses(ideas: readonly Idea[]): Promise<readonly IdeaWithStatus[]> {
  return Promise.all(
    ideas.map(async (idea) => ({
      ...idea,
      status: await fetchCellStatus(idea.cellId)
    }))
  )
}

function ideaFileContent(name: string, idea: string | undefined, createdAt: string): string {
  return `${JSON.stringify({ name, idea: idea ?? null, createdAt }, null, 2)}\n`
}

/** Seeds the in-cell identity: .kaka/idea.json + kv idea:name. */
async function seedCellIdentity(
  cellId: string,
  name: string,
  idea: string | undefined,
  createdAt: string
): Promise<void> {
  const client = getOnCell()
  await client.writeFile(cellId, IDEA_FILE_PATH, ideaFileContent(name, idea, createdAt))
  await client.kvSet(cellId, IDEA_NAME_KEY, name)
}

/**
 * Rewrites the in-cell idea file after an edit, so the Builder's evidence
 * step (read .kaka/idea.json before picking an improvement) always sees the
 * founder's CURRENT idea text — never the text from creation time.
 */
export async function refreshCellIdea(idea: Idea): Promise<void> {
  await getOnCell().writeFile(idea.cellId, IDEA_FILE_PATH, ideaFileContent(idea.name, idea.idea, idea.createdAt))
}

/** Creates the OnCell cell, seeds identity, and registers the idea. */
export async function createIdea(name: string, idea: string | undefined): Promise<Idea> {
  if (getIdea(name) !== undefined) {
    throw new IdeaConflictError(name)
  }
  const client = getOnCell()
  const customerId = ideaCustomerId(name)
  const cell = await client.createCell({ customerId })
  const createdAt = new Date().toISOString()
  await seedCellIdentity(cell.cell_id, name, idea, createdAt)
  if (builderMode() === 'agent') {
    // Deploy is cheap, so the Builder exists from the idea's first breath.
    // Failure is deliberately non-fatal here: the cell and registry entry
    // are already real, and every build/improve run re-deploys anyway.
    try {
      await deployBuilderAgent(client, name, idea ?? '')
    } catch {
      // Re-ensured before every run — see runBuilderAgentPass.
    }
  }
  const record: Idea = {
    name,
    cellId: cell.cell_id,
    customerId,
    ...(idea !== undefined && idea.length > 0 ? { idea } : {}),
    createdAt,
    snapshots: [],
    iterations: []
  }
  return addIdea(record)
}

/** Forks an idea's cell into a new idea (code + files + state). */
export async function forkIdea(sourceName: string, newName: string): Promise<Idea> {
  const source = getIdea(sourceName)
  if (source === undefined) {
    throw new IdeaNotFoundError(sourceName)
  }
  if (getIdea(newName) !== undefined) {
    throw new IdeaConflictError(newName)
  }
  const client = getOnCell()
  const customerId = ideaCustomerId(newName)
  const fork: CellRecord = await client.forkCell(source.cellId, { customerId })
  const createdAt = new Date().toISOString()
  // Re-seed identity in the fork so the copied cell knows its new name.
  await seedCellIdentity(fork.cell_id, newName, source.idea, createdAt)
  const record: Idea = {
    name: newName,
    cellId: fork.cell_id,
    customerId,
    ...(source.idea !== undefined ? { idea: source.idea } : {}),
    createdAt,
    forkedFrom: sourceName,
    ...(source.builtAt !== undefined ? { builtAt: source.builtAt } : {}),
    snapshots: [],
    iterations: source.iterations
  }
  return addIdea(record)
}

/** Snapshots the cell and records the key in the registry. */
export async function snapshotIdea(name: string): Promise<SnapshotEntry> {
  const idea = getIdea(name)
  if (idea === undefined) {
    throw new IdeaNotFoundError(name)
  }
  const snapshot = await getOnCell().snapshotCell(idea.cellId)
  const entry: SnapshotEntry = {
    key: snapshot.snapshot_key,
    at: typeof snapshot.created_at === 'string' ? snapshot.created_at : new Date().toISOString()
  }
  recordSnapshot(name, entry)
  return entry
}

/**
 * Deletes an idea. Unless keepRemote is set, the OnCell cell is deleted
 * too (a 404 upstream is tolerated — the registry entry still goes away).
 */
export async function deleteIdea(name: string, keepRemote: boolean): Promise<void> {
  const idea = getIdea(name)
  if (idea === undefined) {
    throw new IdeaNotFoundError(name)
  }
  if (!keepRemote) {
    try {
      await getOnCell().deleteCell(idea.cellId)
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error
      }
    }
  }
  removeIdea(name)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  )
}

export class IdeaNotFoundError extends Error {
  constructor(name: string) {
    super(`idea "${name}" not found`)
    this.name = 'IdeaNotFoundError'
  }
}

export class IdeaConflictError extends Error {
  constructor(name: string) {
    super(`idea "${name}" already exists`)
    this.name = 'IdeaConflictError'
  }
}
