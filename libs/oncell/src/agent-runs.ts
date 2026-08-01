/**
 * Runtime-level agent run observation over the OnCell public API.
 *
 * getLatestAgentRun — GET /api/v1/agents/{name}/runs/latest
 * getAgentRunFeed  — GET /api/v1/agents/{name}/runs/{runId}/feed?after=N
 *
 * The feed is what the RUNTIME sees of a run's loop (tool calls, steps,
 * cost) and needs no cooperation from the agent's own code — it exists so
 * callers can show live progress even when the agent writes nothing.
 * Both calls are pure reads, so they use the transport's idempotent retry.
 */

import { OnCellApiError, OnCellInputError } from './errors'
import { sendRequest, type HttpConfig } from './http'
import type { AgentRunFeedEntry, AgentRunFeedPage, AgentRunRecord } from './types'
import { requireNonEmptyString } from './validate'

/** The agent-runs sub-API mixed into the client. */
export interface AgentRunsApi {
  /** GET /api/v1/agents/{name}/runs/latest — the agent's most recent run. */
  getLatestAgentRun(agentName: string): Promise<AgentRunRecord>
  /** GET /api/v1/agents/{name}/runs/{runId}/feed?after=N — one feed page. */
  getAgentRunFeed(agentName: string, runId: string, after?: number): Promise<AgentRunFeedPage>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes a wire feed page: `entries` must be an array (anything else is
 * an unexpected response); a missing `next` falls back to `after` plus the
 * page length so cursors never go backwards; `done` is strictly boolean.
 */
function toFeedPage(data: unknown, after: number): AgentRunFeedPage {
  if (!isRecord(data) || !Array.isArray(data['entries'])) {
    throw new OnCellApiError({
      status: 200,
      code: 'UNEXPECTED_RESPONSE',
      message: 'expected {entries, next, done} from the run feed endpoint'
    })
  }
  const entries = data['entries'] as readonly AgentRunFeedEntry[]
  const next = typeof data['next'] === 'number' ? data['next'] : after + entries.length
  return { entries, next, done: data['done'] === true }
}

/** Builds the agent-runs helpers bound to a transport config. */
export function createAgentRunsApi(config: HttpConfig): AgentRunsApi {
  async function getLatestAgentRun(agentName: string): Promise<AgentRunRecord> {
    requireNonEmptyString(agentName, 'agentName')
    const result = await sendRequest<AgentRunRecord>(config, {
      method: 'GET',
      path: `/api/v1/agents/${encodeURIComponent(agentName)}/runs/latest`,
      idempotent: true
    })
    return result.data
  }

  async function getAgentRunFeed(
    agentName: string,
    runId: string,
    after = 0
  ): Promise<AgentRunFeedPage> {
    requireNonEmptyString(agentName, 'agentName')
    requireNonEmptyString(runId, 'runId')
    if (!Number.isInteger(after) || after < 0) {
      throw new OnCellInputError('after must be a non-negative integer')
    }
    const result = await sendRequest<unknown>(config, {
      method: 'GET',
      path: `/api/v1/agents/${encodeURIComponent(agentName)}/runs/${encodeURIComponent(runId)}/feed?after=${after}`,
      idempotent: true
    })
    return toFeedPage(result.data, after)
  }

  return { getLatestAgentRun, getAgentRunFeed }
}
