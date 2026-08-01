/**
 * Agent-mode build/improve orchestration. kaka's server does exactly four
 * things per run: (re)deploy the idea's Builder agent, snapshot the cell
 * (the rollback point — the agent has no snapshot tool, so the platform
 * takes it and passes the key in the task args), fire the task, then poll
 * the cell's `kaka:progress` kv and relay the agent's entries as the same
 * NDJSON stage events the browser always understood. The run token in the
 * task args disambiguates concurrent/old runs.
 *
 * Failures surface as clear error events — there is NO silent fallback to
 * the local Anthropic builder (that path is the KAKA_BUILDER_MODE=local
 * escape hatch).
 */

import { randomUUID } from 'node:crypto'
import type { OnCellClient } from '@platform/oncell'
import { getOnCell } from '../oncell'
import { updateIdea, type Idea, type LastCheck } from '../registry'
import { builderAgentName, PROGRESS_KEY } from './agent-def'
import { deployBuilderAgent } from './deploy'
import {
  parseCheckedDetail,
  parseProgressEntries,
  toStreamEvent,
  type ProgressEntry
} from './progress'
import { syncIterationsFromCell } from './sync'

export const DEFAULT_POLL_INTERVAL_MS = 2000
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000
const MAX_LAST_CHECK_OUTPUT_CHARS = 4000

export type AgentPassKind = 'build' | 'improve'

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

/** Records the outcome on the registry and emits the terminal done event. */
async function finalizeDone(
  oncell: OnCellClient,
  idea: Idea,
  observations: RunObservations,
  emit: Emit
): Promise<void> {
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
 * cell's progress kv every ~2s, streaming stage events until the agent
 * records done/error for this run (or the deadline passes).
 */
export async function runBuilderAgentPass(
  idea: Idea,
  ideaText: string,
  kind: AgentPassKind,
  emit: Emit
): Promise<void> {
  const oncell = getOnCell()
  const agentName = builderAgentName(idea.name)
  const pollIntervalMs = envInt('KAKA_AGENT_POLL_MS', DEFAULT_POLL_INTERVAL_MS)
  const timeoutMs = envInt('KAKA_AGENT_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS)

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
  let invokeFailure: unknown
  // Fire the task; the agent reports through the cell, not the invocation.
  void oncell
    .invokeAgentTask(agentName, kind, {
      cell_id: idea.cellId,
      run,
      snapshot_key: snapshot.snapshot_key
    })
    .catch((error: unknown) => {
      invokeFailure = error
    })

  const deadline = Date.now() + timeoutMs
  let observations: RunObservations = {}
  let relayed = 0

  while (Date.now() < deadline) {
    if (invokeFailure !== undefined) {
      emitAgentUnavailable(emit, 'invoked', invokeFailure)
      return
    }
    const entries = await readRunProgress(oncell, idea.cellId, run)
    if (entries !== undefined) {
      for (const entry of entries.slice(relayed)) {
        observations = observe(observations, entry)
        if (entry.stage === 'done') {
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
