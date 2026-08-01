/**
 * Progress and iteration state the Builder agent records on the IDEA's
 * cell — schema validation and mapping onto the NDJSON stage events the
 * browser already understands. Everything here is tolerant: the kv values
 * are written by a model, so invalid entries are skipped, never fatal.
 */

import { z } from 'zod'
import { iterationSchema, type Iteration } from '../registry'

/** One progress entry the agent appends to kv `kaka:progress`. */
export const progressEntrySchema = z.object({
  ts: z.string().min(1),
  run: z.string().min(1),
  stage: z.string().min(1),
  detail: z.string().optional()
})

export type ProgressEntry = z.infer<typeof progressEntrySchema>

/**
 * Stages equivalent to a successful "done". The model sometimes improvises
 * terminal wording ("shipped") instead of the protocol's "done" — kaka
 * treats it as done rather than letting the run time out.
 */
export const DONE_STAGES: ReadonlySet<string> = new Set(['done', 'shipped'])

/** Stages that end a run. */
export const TERMINAL_STAGES: ReadonlySet<string> = new Set([...DONE_STAGES, 'error'])

/** Parsed `{"exitCode","output"}` payload of a "checked" entry's detail. */
export interface CheckedDetail {
  readonly exitCode: number
  readonly output: string
}

const checkedDetailSchema = z.object({
  exitCode: z.number().int(),
  output: z.string()
})

/**
 * Normalizes a kv value (JSON string, or already-parsed array) into an
 * unknown[] — the agent writes JSON strings, but be liberal in what we accept.
 */
function toUnknownArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/** Valid progress entries from a raw kv value; invalid entries are skipped. */
export function parseProgressEntries(value: unknown): readonly ProgressEntry[] {
  return toUnknownArray(value).flatMap((candidate) => {
    const parsed = progressEntrySchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
}

/** Valid iterations from a raw kv value; invalid entries are skipped. */
export function parseCellIterations(value: unknown): readonly Iteration[] {
  return toUnknownArray(value).flatMap((candidate) => {
    const parsed = iterationSchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
}

/** Parses a "checked" entry's detail; undefined when malformed. */
export function parseCheckedDetail(detail: string | undefined): CheckedDetail | undefined {
  if (detail === undefined) {
    return undefined
  }
  try {
    const parsed = checkedDetailSchema.safeParse(JSON.parse(detail))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Maps a non-terminal progress entry onto the browser's stage-event schema.
 * Internal entries (checked, service-error) return undefined — they are
 * folded into the terminal done result instead of streamed.
 */
export function toStreamEvent(entry: ProgressEntry): object | undefined {
  switch (entry.stage) {
    case 'file':
      return entry.detail !== undefined ? { stage: 'file', path: entry.detail } : { stage: 'file' }
    case 'live':
      return entry.detail !== undefined ? { stage: 'live', url: entry.detail } : undefined
    case 'scheduled':
      return entry.detail !== undefined
        ? { stage: 'scheduled', wakeAt: entry.detail }
        : { stage: 'scheduled' }
    case 'checked':
    case 'service-error':
      return undefined
    default:
      return { stage: entry.stage }
  }
}
