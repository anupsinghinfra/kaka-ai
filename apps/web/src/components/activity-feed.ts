/**
 * Pure formatting for the live run feed's runtime activity — the ops OnCell
 * observes during an agent run (relayed as {stage:"activity"} NDJSON
 * events) — plus the running cost ticker. Kept out of the component so the
 * feed's bread-and-butter rendering is unit-testable.
 */

/** The activity fields of a stream event (all optional on the wire). */
export interface ActivityStreamEvent {
  readonly op?: string
  readonly summary?: string
  readonly cost?: number
  readonly durationMs?: number
}

/** Runtime "step" ops render as quiet counters, not gear lines. */
const STEP_OP = 'step'

function formatDuration(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`
}

/**
 * One monospace feed line per activity event:
 *   ⚙ cells_write_file src/server.js
 *   ⚙ cells_exec node src/check.js (2.1s)
 *   · step 12
 * The op is prepended only when the summary does not already carry it.
 */
export function activityLineText(event: ActivityStreamEvent): string {
  const op = event.op ?? ''
  const summary = event.summary ?? ''
  const body =
    summary.length === 0 ? op : op.length === 0 || summary.startsWith(op) ? summary : `${op} ${summary}`
  const marker = op === STEP_OP ? '·' : '⚙'
  const duration = typeof event.durationMs === 'number' ? ` (${formatDuration(event.durationMs)})` : ''
  return `${marker} ${body}${duration}`
}

/** Adds an event's cost (dollars, if any) to the running total. */
export function accumulateCost(total: number, cost: number | undefined): number {
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? total + cost : total
}

/** "$0.42 so far" — the panel-header ticker; undefined until any cost. */
export function formatCostTicker(total: number): string | undefined {
  return total > 0 ? `$${total.toFixed(2)} so far` : undefined
}
