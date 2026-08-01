/**
 * Runtime-level live feed for one agent run. OnCell observes the agent's
 * loop from the outside (tool calls, steps, cost) with NO cooperation from
 * the agent's own code — so the browser feed stays alive even when the
 * model writes little or no kv progress. This module owns discovering the
 * current run (runs/latest, tolerant of 404s while the run spins up) and
 * draining its feed pages into `activity` stream events.
 */

import type { AgentRunFeedEntry, OnCellClient } from '@platform/oncell'

/** Clock-skew allowance when matching runs/latest to our invocation. */
const RUN_MATCH_SKEW_MS = 30_000

/** The NDJSON activity event relayed to the browser for one feed entry. */
export interface ActivityEvent {
  readonly stage: 'activity'
  readonly op: string
  readonly summary: string
  readonly ts: string
  readonly cost?: number
  readonly durationMs?: number
}

/** Maps one feed entry onto the browser's activity event. */
export function toActivityEvent(entry: AgentRunFeedEntry): ActivityEvent {
  return {
    stage: 'activity',
    op: entry.op,
    summary: entry.summary,
    ts: entry.ts,
    ...(typeof entry.cost === 'number' ? { cost: entry.cost } : {}),
    ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {})
  }
}

/** Incremental poller over one run's feed. Every failure is tolerated. */
export interface RunFeedPoller {
  /** True once the runtime reported the run's loop terminated. */
  isDone(): boolean
  /** Total feed entries relayed so far (evidence the run really started). */
  relayedCount(): number
  /**
   * New entries since the last poll. Returns [] on any failure — 404s while
   * the run spins up are expected, and the kv deadline still applies.
   */
  poll(): Promise<readonly AgentRunFeedEntry[]>
}

/**
 * Creates a poller that first discovers the run via runs/latest (accepting
 * only a run that started at/after our invocation, so a previous run's feed
 * is never replayed), then pages through its feed with the `after` cursor.
 */
export function createRunFeedPoller(
  oncell: OnCellClient,
  agentName: string,
  invokedAtMs: number
): RunFeedPoller {
  let runId: string | undefined
  let after = 0
  let done = false
  let relayed = 0

  function isThisRun(startedAt: unknown, active: unknown): boolean {
    const startedMs = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN
    if (!Number.isNaN(startedMs)) {
      return startedMs >= invokedAtMs - RUN_MATCH_SKEW_MS
    }
    // No usable timestamp — fall back to the runtime's own liveness flag.
    return active === true
  }

  async function poll(): Promise<readonly AgentRunFeedEntry[]> {
    if (done) {
      return []
    }
    try {
      if (runId === undefined) {
        const latest = await oncell.getLatestAgentRun(agentName)
        if (
          typeof latest.runId !== 'string' ||
          latest.runId.length === 0 ||
          !isThisRun(latest.startedAt, latest.active)
        ) {
          return []
        }
        runId = latest.runId
      }
      const page = await oncell.getAgentRunFeed(agentName, runId, after)
      after = page.next
      if (page.done) {
        done = true
      }
      relayed += page.entries.length
      return page.entries
    } catch {
      // Spin-up 404s and transient failures — the next poll tries again.
      return []
    }
  }

  return {
    isDone: () => done,
    relayedCount: () => relayed,
    poll
  }
}
