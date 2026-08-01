/**
 * Venture registry — durable JSON at ~/.kaka/registry.json (override the
 * directory with KAKA_HOME). Writes are atomic (tmp file + rename) and the
 * file is schema-validated on every load. All update helpers are immutable:
 * they return new registry objects and never mutate their inputs.
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

export const ventureSchema = z.object({
  name: z.string().min(1),
  cellId: z.string().min(1),
  customerId: z.string().min(1),
  idea: z.string().optional(),
  createdAt: z.string().min(1),
  forkedFrom: z.string().optional(),
  builtAt: z.string().optional(),
  snapshots: z.array(snapshotEntrySchema)
})

export const registrySchema = z.object({
  version: z.literal(1),
  ventures: z.array(ventureSchema)
})

export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>
export type Venture = z.infer<typeof ventureSchema>
export type Registry = z.infer<typeof registrySchema>

export const EMPTY_REGISTRY: Registry = Object.freeze({ version: 1, ventures: [] })

/** Resolves the kaka home directory (KAKA_HOME wins over ~/.kaka). */
export function kakaHome(): string {
  const fromEnv = process.env.KAKA_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv
  }
  return join(homedir(), '.kaka')
}

export function registryPath(): string {
  return join(kakaHome(), 'registry.json')
}

/**
 * Loads and validates the registry. A missing file yields the empty
 * registry; a malformed or schema-invalid file throws with context so the
 * caller can surface a useful error instead of silently losing data.
 */
export function loadRegistry(): Registry {
  let raw: string
  try {
    raw = readFileSync(registryPath(), 'utf8')
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') {
      return EMPTY_REGISTRY
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`venture registry at ${registryPath()} is not valid JSON`)
  }
  const result = registrySchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `venture registry at ${registryPath()} failed schema validation: ${result.error.message}`
    )
  }
  return result.data
}

/** Atomically persists the registry: write to a tmp file, then rename. */
export function saveRegistry(registry: Registry): void {
  const validated = registrySchema.parse(registry)
  const dir = kakaHome()
  mkdirSync(dir, { recursive: true })
  const target = registryPath()
  const tmp = join(dir, `.registry.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

export function listVentures(): readonly Venture[] {
  return loadRegistry().ventures
}

export function getVenture(name: string): Venture | undefined {
  return loadRegistry().ventures.find((venture) => venture.name === name)
}

/** Adds a venture; throws when the name is already registered. */
export function addVenture(venture: Venture): Venture {
  const registry = loadRegistry()
  if (registry.ventures.some((existing) => existing.name === venture.name)) {
    throw new Error(`venture "${venture.name}" already exists in the registry`)
  }
  const next: Registry = { ...registry, ventures: [...registry.ventures, venture] }
  saveRegistry(next)
  return venture
}

/** Applies an immutable patch to a venture; throws when it does not exist. */
export function updateVenture(
  name: string,
  patch: Partial<Omit<Venture, 'name'>>
): Venture {
  const registry = loadRegistry()
  const existing = registry.ventures.find((venture) => venture.name === name)
  if (existing === undefined) {
    throw new Error(`venture "${name}" not found in the registry`)
  }
  const updated: Venture = { ...existing, ...patch }
  const next: Registry = {
    ...registry,
    ventures: registry.ventures.map((venture) => (venture.name === name ? updated : venture))
  }
  saveRegistry(next)
  return updated
}

/** Appends a snapshot record to a venture's history. */
export function recordSnapshot(name: string, snapshot: SnapshotEntry): Venture {
  const registry = loadRegistry()
  const existing = registry.ventures.find((venture) => venture.name === name)
  if (existing === undefined) {
    throw new Error(`venture "${name}" not found in the registry`)
  }
  return updateVenture(name, { snapshots: [...existing.snapshots, snapshot] })
}

/** Removes a venture; returns true when something was removed. */
export function removeVenture(name: string): boolean {
  const registry = loadRegistry()
  const remaining = registry.ventures.filter((venture) => venture.name !== name)
  if (remaining.length === registry.ventures.length) {
    return false
  }
  saveRegistry({ ...registry, ventures: remaining })
  return true
}
