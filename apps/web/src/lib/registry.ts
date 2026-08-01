/**
 * Startup-idea registry — durable JSON at ~/.kaka/ideas.json (override the
 * directory with KAKA_HOME). Writes are atomic (tmp file + rename) and the
 * file is schema-validated on every load. On unparseable or foreign content
 * the store REFUSES with a clear error naming the file — it never silently
 * re-initializes. A legacy ~/.kaka/registry.json that parses as ours is
 * migrated once into ideas.json. All update helpers are immutable: they
 * return new registry objects and never mutate their inputs.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const snapshotEntrySchema = z.object({
  key: z.string().min(1),
  at: z.string().min(1)
})

/** One shipped version of the app: v1 is the initial build, v2+ improvements. */
export const iterationSchema = z.object({
  v: z.number().int().positive(),
  summary: z.string(),
  at: z.string().min(1),
  checkPassed: z.boolean(),
  snapshotKey: z.string().optional()
})

/** The latest self-test result, kept so the next iteration can react to it. */
export const lastCheckSchema = z.object({
  exitCode: z.number().int(),
  output: z.string()
})

export const ideaSchema = z.object({
  name: z.string().min(1),
  cellId: z.string().min(1),
  customerId: z.string().min(1),
  idea: z.string().optional(),
  createdAt: z.string().min(1),
  forkedFrom: z.string().optional(),
  builtAt: z.string().optional(),
  snapshots: z.array(snapshotEntrySchema),
  iterations: z.array(iterationSchema).default([]),
  lastCheck: lastCheckSchema.optional()
})

export const registrySchema = z.object({
  version: z.literal(1),
  ideas: z.array(ideaSchema)
})

/** The pre-rename on-disk format (~/.kaka/registry.json with "ventures"). */
const legacyRegistrySchema = z.object({
  version: z.literal(1),
  ventures: z.array(ideaSchema)
})

export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>
export type Iteration = z.infer<typeof iterationSchema>
export type LastCheck = z.infer<typeof lastCheckSchema>
export type Idea = z.infer<typeof ideaSchema>
export type Registry = z.infer<typeof registrySchema>

export const EMPTY_REGISTRY: Registry = Object.freeze({ version: 1, ideas: [] })

/** Resolves the kaka home directory (KAKA_HOME wins over ~/.kaka). */
export function kakaHome(): string {
  const fromEnv = process.env.KAKA_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv
  }
  return join(homedir(), '.kaka')
}

export function registryPath(): string {
  return join(kakaHome(), 'ideas.json')
}

/** The pre-rename registry location, read once for migration. */
export function legacyRegistryPath(): string {
  return join(kakaHome(), 'registry.json')
}

function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * One-time migration: if the legacy registry.json exists AND parses as our
 * old format, convert it to the idea registry and persist ideas.json.
 * Foreign or unparseable legacy files are left alone and ignored.
 */
function migrateLegacyRegistry(): Registry | undefined {
  const raw = readFileOrUndefined(legacyRegistryPath())
  if (raw === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const legacy = legacyRegistrySchema.safeParse(parsed)
  if (!legacy.success) {
    return undefined
  }
  const migrated: Registry = { version: 1, ideas: legacy.data.ventures }
  saveRegistry(migrated)
  return migrated
}

/**
 * Loads and validates the registry. A missing ideas.json triggers the
 * one-time legacy migration, then falls back to the empty registry. A
 * malformed or foreign file throws with the file path so the caller can
 * surface a useful error instead of silently losing data.
 */
export function loadRegistry(): Registry {
  const raw = readFileOrUndefined(registryPath())
  if (raw === undefined) {
    return migrateLegacyRegistry() ?? EMPTY_REGISTRY
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `idea registry at ${registryPath()} is not valid JSON — refusing to touch it. ` +
        'Fix or move the file, then retry.'
    )
  }
  const result = registrySchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `file at ${registryPath()} does not look like a kaka idea registry — refusing to touch it ` +
        `(schema validation: ${result.error.message})`
    )
  }
  return result.data
}

/**
 * Refuses to overwrite a file that is not a kaka idea registry. Guards
 * saveRegistry so an atomic rename can never clobber foreign data.
 */
function assertTargetIsOurs(target: string): void {
  const raw = readFileOrUndefined(target)
  if (raw === undefined) {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `refusing to overwrite ${target}: existing content is not valid JSON. ` +
        'Fix or move the file, then retry.'
    )
  }
  const isOurs =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { version?: unknown }).version === 1 &&
    Array.isArray((parsed as { ideas?: unknown }).ideas)
  if (!isOurs) {
    throw new Error(
      `refusing to overwrite ${target}: existing content is not a kaka idea registry. ` +
        'Move the file out of the way, then retry.'
    )
  }
}

/** Atomically persists the registry: write to a tmp file, then rename. */
export function saveRegistry(registry: Registry): void {
  const validated = registrySchema.parse(registry)
  const dir = kakaHome()
  mkdirSync(dir, { recursive: true })
  const target = registryPath()
  assertTargetIsOurs(target)
  const tmp = join(dir, `.ideas.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

export function listIdeas(): readonly Idea[] {
  return loadRegistry().ideas
}

export function getIdea(name: string): Idea | undefined {
  return loadRegistry().ideas.find((idea) => idea.name === name)
}

/** Adds an idea; throws when the name is already registered. */
export function addIdea(idea: Idea): Idea {
  const registry = loadRegistry()
  if (registry.ideas.some((existing) => existing.name === idea.name)) {
    throw new Error(`idea "${idea.name}" already exists in the registry`)
  }
  const next: Registry = { ...registry, ideas: [...registry.ideas, idea] }
  saveRegistry(next)
  return idea
}

/** Applies an immutable patch to an idea; throws when it does not exist. */
export function updateIdea(name: string, patch: Partial<Omit<Idea, 'name'>>): Idea {
  const registry = loadRegistry()
  const existing = registry.ideas.find((idea) => idea.name === name)
  if (existing === undefined) {
    throw new Error(`idea "${name}" not found in the registry`)
  }
  const updated: Idea = { ...existing, ...patch }
  const next: Registry = {
    ...registry,
    ideas: registry.ideas.map((idea) => (idea.name === name ? updated : idea))
  }
  saveRegistry(next)
  return updated
}

/** Appends a snapshot record to an idea's history. */
export function recordSnapshot(name: string, snapshot: SnapshotEntry): Idea {
  const existing = getIdea(name)
  if (existing === undefined) {
    throw new Error(`idea "${name}" not found in the registry`)
  }
  return updateIdea(name, { snapshots: [...existing.snapshots, snapshot] })
}

/** Appends an iteration to an idea's timeline. */
export function recordIteration(name: string, iteration: Iteration): Idea {
  const existing = getIdea(name)
  if (existing === undefined) {
    throw new Error(`idea "${name}" not found in the registry`)
  }
  return updateIdea(name, { iterations: [...existing.iterations, iteration] })
}

/** Removes an idea; returns true when something was removed. */
export function removeIdea(name: string): boolean {
  const registry = loadRegistry()
  const remaining = registry.ideas.filter((idea) => idea.name !== name)
  if (remaining.length === registry.ideas.length) {
    return false
  }
  saveRegistry({ ...registry, ideas: remaining })
  return true
}

/** The highest shipped version (0 when nothing has been built yet). */
export function currentVersion(idea: Pick<Idea, 'iterations' | 'builtAt'>): number {
  if (idea.iterations.length > 0) {
    return Math.max(...idea.iterations.map((iteration) => iteration.v))
  }
  // Legacy records built before iteration tracking count as v1.
  return idea.builtAt !== undefined ? 1 : 0
}

/** The version the next improvement will ship as. */
export function nextVersion(idea: Pick<Idea, 'iterations' | 'builtAt'>): number {
  return currentVersion(idea) + 1
}
