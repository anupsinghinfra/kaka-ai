/**
 * Agent-mode build/improve orchestration. kaka's server does exactly four
 * things per run: (re)deploy the idea's Builder agent, snapshot the cell
 * (the rollback point — the agent has no snapshot tool, so the platform
 * takes it and passes the key in the task args), fire the task, then poll
 * two independent progress sources and relay both as NDJSON events:
 *
 * - the cell's `kaka:progress` kv — the agent's own milestone narrative
 *   (generating/writing/live/…), which the model writes voluntarily; and
 * - the run's RUNTIME feed (runs/latest + runs/{id}/feed) — what OnCell
 *   observes of the loop (tool calls, steps, cost) with no agent
 *   cooperation, relayed as {stage:"activity"} events.
 *
 * The feed's `done` complements kv done: when the runtime says the loop
 * terminated but the agent never recorded done/shipped, kaka waits a short
 * tail then finalizes from cell state — the run ended, reflect reality.
 * Finalization also enforces kaka's guarantee that the app is RUNNING
 * (the model sometimes skips the service-start step under step pressure).
 *
 * Failures surface as clear error events — there is NO silent fallback to
 * the local Anthropic builder (that path is the KAKA_BUILDER_MODE=local
 * escape hatch).
 */

import { randomUUID } from 'node:crypto'
import type { OnCellClient } from '@platform/oncell'
import { getOnCell } from '../oncell'
import { restartAppService, resolvePreviewUrl } from '../builder/service'
import { updateIdea, type Idea, type LastCheck } from '../registry'
import { builderAgentName, PROGRESS_KEY } from './agent-def'
import { deployBuilderAgent } from './deploy'
import { createRunFeedPoller, toActivityEvent } from './feed'
import {
  DONE_STAGES,
  parseCheckedDetail,
  parseProgressEntries,
  toStreamEvent,
  type ProgressEntry
} from './progress'
import { syncIterationsFromCell } from './sync'

export const DEFAULT_POLL_INTERVAL_MS = 2000
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000
/** Grace after the runtime feed reports the loop ended, for kv to catch up. */
export const DEFAULT_FEED_DONE_TAIL_MS = 10_000
const MAX_LAST_CHECK_OUTPUT_CHARS = 4000

export type AgentPassKind = 'build' | 'improve'

/** Per-run options threaded from the route into the task args. */
export interface AgentPassOptions {
  /** Founder direction for this revision (manual improve only). */
  readonly direction?: string
}

type Emit = (event: object) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.length === 0) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function emitAgentUnavailable(emit: Emit, phase: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  emit({
    stage: 'error',
    error: {
      code: 'AGENT_UNAVAILABLE',
      message: `the Builder agent could not be ${phase}: ${message}`,
      remediation:
        'OnCell agents look unavailable. Retry, or set KAKA_BUILDER_MODE=local in the repo-root .env to use the local builder.'
    }
  })
}

/** Progress entries for this run, oldest first (tolerates read failures). */
async function readRunProgress(
  oncell: OnCellClient,
  cellId: string,
  run: string
): Promise<readonly ProgressEntry[] | undefined> {
  try {
    const result = await oncell.kvGet(cellId, PROGRESS_KEY)
    return parseProgressEntries(result.value).filter((entry) => entry.run === run)
  } catch {
    // Transient read failures are tolerated — the run deadline still applies.
    return undefined
  }
}

interface RunObservations {
  liveUrl?: string
  serviceError?: string
  lastCheck?: LastCheck
}

/** Folds one entry into the run's accumulated observations. */
function observe(observations: RunObservations, entry: ProgressEntry): RunObservations {
  if (entry.stage === 'live' && entry.detail !== undefined) {
    return { ...observations, liveUrl: entry.detail, serviceError: undefined }
  }
  if (entry.stage === 'service-error') {
    return { ...observations, serviceError: entry.detail ?? 'the app service failed to start' }
  }
  if (entry.stage === 'checked') {
    const checked = parseCheckedDetail(entry.detail)
    if (checked !== undefined) {
      return {
        ...observations,
        lastCheck: {
          exitCode: checked.exitCode,
          output: checked.output.slice(0, MAX_LAST_CHECK_OUTPUT_CHARS)
        }
      }
    }
  }
  return observations
}

/** True when the cell's app service is running (any failure means no). */
async function isServiceRunning(oncell: OnCellClient, cellId: string): Promise<boolean> {
  try {
    const service = await oncell.getService(cellId)
    return service.running === true
  } catch {
    // getService 503s (NO_APP_RUNNING) until something is started.
    return false
  }
}

/**
 * kaka's guarantee: after a run finalizes, the app is RUNNING — enforced by
 * the platform, not by agent compliance (the briefing's service-start step
 * gets skipped when the model compresses under step pressure). Repairs the
 * service when needed, emits the {stage:"live"} payoff, and returns the
 * corrected observations. A failed start stays non-fatal (serviceError).
 */
async function ensureAppRunning(
  oncell: OnCellClient,
  idea: Idea,
  observations: RunObservations,
  emit: Emit
): Promise<RunObservations> {
  if (await isServiceRunning(oncell, idea.cellId)) {
    if (observations.liveUrl !== undefined) {
      return observations
    }
    // Running but never reported — reflect reality with the real URL.
    const liveUrl = await resolvePreviewUrl(oncell, idea.cellId)
    emit({ stage: 'live', url: liveUrl })
    return { ...observations, liveUrl, serviceError: undefined }
  }
  const outcome = await restartAppService(oncell, idea)
  if (outcome.ok) {
    emit({ stage: 'live', url: outcome.liveUrl })
    return { ...observations, liveUrl: outcome.liveUrl, serviceError: undefined }
  }
  return { ...observations, liveUrl: undefined, serviceError: outcome.serviceError }
}

/**
 * Records the outcome on the registry and emits the terminal done event.
 * Every finalization path (kv done, improvised "shipped", feed-done
 * reconciliation) funnels through here, so the app-running guarantee holds
 * everywhere.
 */
async function finalizeDone(
  oncell: OnCellClient,
  idea: Idea,
  observed: RunObservations,
  emit: Emit
): Promise<void> {
  const observations = await ensureAppRunning(oncell, idea, observed, emit)
  const synced = await syncIterationsFromCell(oncell, idea)
  const iteration =
    synced.iterations.length > 0
      ? [...synced.iterations].sort((a, b) => a.v - b.v).at(-1)
      : undefined
  updateIdea(idea.name, {
    ...(observations.lastCheck !== undefined ? { lastCheck: observations.lastCheck } : {}),
    ...(observations.liveUrl !== undefined
      ? { liveUrl: observations.liveUrl, serviceError: undefined }
      : {}),
    ...(observations.serviceError !== undefined && observations.liveUrl === undefined
      ? { liveUrl: undefined, serviceError: observations.serviceError }
      : {})
  })
  emit({
    stage: 'done',
    result: {
      ...(iteration !== undefined ? { iteration } : {}),
      ...(observations.lastCheck !== undefined
        ? {
            check: {
              exit_code: observations.lastCheck.exitCode,
              stdout: observations.lastCheck.output,
              stderr: ''
            }
          }
        : {}),
      ...(observations.liveUrl !== undefined ? { liveUrl: observations.liveUrl } : {}),
      ...(observations.serviceError !== undefined && observations.liveUrl === undefined
        ? { serviceError: observations.serviceError }
        : {})
    }
  })
}

/**
 * Runs one agent-mode pass: deploy → snapshot → invoke (fire) → poll the
 * cell's progress kv AND the run's runtime feed every ~2s, streaming stage
 * and activity events until the agent records done/error for this run, the
 * runtime feed reports the loop ended (short tail, then finalize from cell
 * state), or the deadline passes.
 */
export async function runBuilderAgentPass(
  idea: Idea,
  ideaText: string,
  kind: AgentPassKind,
  emit: Emit,
  options: AgentPassOptions = {}
): Promise<void> {
  const oncell = getOnCell()
  const agentName = builderAgentName(idea.name)
  const pollIntervalMs = envInt('KAKA_AGENT_POLL_MS', DEFAULT_POLL_INTERVAL_MS)
  const timeoutMs = envInt('KAKA_AGENT_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS)
  const feedTailMs = envInt('KAKA_AGENT_FEED_TAIL_MS', DEFAULT_FEED_DONE_TAIL_MS)

  emit({ stage: 'preparing' })
  try {
    await deployBuilderAgent(oncell, idea.name, ideaText)
  } catch (error: unknown) {
    emitAgentUnavailable(emit, 'deployed', error)
    return
  }

  emit({ stage: 'snapshotting' })
  const snapshot = await oncell.snapshotCell(idea.cellId)

  const run = `run-${randomUUID()}`
  const direction = options.direction?.trim()
  let invokeFailure: unknown
  // Fire the task; the agent reports through the cell, not the invocation.
  // The invocation response is expendable: agent runs outlive the edge's
  // idle timeout (the ALB 504s at ~60s while the run keeps executing on the
  // host), so a failed/timed-out invoke only matters if progress never
  // appears — give the run a grace window before declaring it dead.
  void oncell
    .invokeAgentTask(agentName, kind, {
      cell_id: idea.cellId,
      run,
      snapshot_key: snapshot.snapshot_key,
      ...(direction !== undefined && direction.length > 0 ? { direction } : {})
    })
    .catch((error: unknown) => {
      invokeFailure = error
    })

  const invokeGraceMs = Number(process.env.KAKA_AGENT_INVOKE_GRACE_MS || 120_000)
  const started = Date.now()
  const deadline = started + timeoutMs
  const feed = createRunFeedPoller(oncell, agentName, started)
  let feedDoneAt: number | undefined
  let observations: RunObservations = {}
  let relayed = 0

  while (Date.now() < deadline) {
    if (
      invokeFailure !== undefined &&
      relayed === 0 &&
      feed.relayedCount() === 0 &&
      Date.now() - started > invokeGraceMs
    ) {
      emitAgentUnavailable(emit, 'invoked', invokeFailure)
      return
    }
    const entries = await readRunProgress(oncell, idea.cellId, run)
    if (entries !== undefined) {
      for (const entry of entries.slice(relayed)) {
        observations = observe(observations, entry)
        if (DONE_STAGES.has(entry.stage)) {
          if (entry.stage !== 'done') {
            // The model improvised its terminal stage — relay it verbatim
            // as a milestone, then finalize exactly like done.
            emit({ stage: entry.stage })
          }
          await finalizeDone(oncell, idea, observations, emit)
          return
        }
        if (entry.stage === 'error') {
          emit({
            stage: 'error',
            error: {
              code: 'AGENT_RUN_FAILED',
              message: entry.detail ?? 'the Builder agent reported a failure'
            }
          })
          return
        }
        const event = toStreamEvent(entry)
        if (event !== undefined) {
          emit(event)
        }
      }
      relayed = entries.length
    }
    for (const feedEntry of await feed.poll()) {
      emit(toActivityEvent(feedEntry))
    }
    if (feed.isDone() && feedDoneAt === undefined) {
      feedDoneAt = Date.now()
    }
    if (feedDoneAt !== undefined && Date.now() - feedDoneAt >= feedTailMs) {
      // The runtime says the loop terminated but the agent never recorded
      // done/shipped. The kv had its tail to catch up — finalize from cell
      // state instead of timing out: the run ended, reflect reality.
      await finalizeDone(oncell, idea, observations, emit)
      return
    }
    await sleep(pollIntervalMs)
  }

  emit({
    stage: 'error',
    error: {
      code: 'AGENT_RUN_TIMEOUT',
      message: `the Builder agent did not finish within ${Math.round(timeoutMs / 60_000)} minutes`,
      remediation: 'Check the idea page later — the agent records its result in the cell when it finishes.'
    }
  })
}
