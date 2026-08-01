/**
 * Agent deployment and invocation over the OnCell public API.
 *
 * deployAgent   — POST /api/v1/deploy {source, agentName, manifest}
 * invokeAgentTask — POST /api/v1/agents/{name}/{task} with the task args
 *
 * The manifest is the identity/capabilities/skills wire contract from
 * OnCell's agent model (docs/agent-model.md in the OnCell repo). Neither
 * call is retried: deploy registers a new version per call, and a task
 * invocation runs real work.
 */

import { sendRequest, type HttpConfig } from './http'
import type { AgentDeployRecord, DeployAgentInput } from './types'
import { requireNonEmptyString } from './validate'

/** The agent sub-API mixed into the client. */
export interface AgentApi {
  /** POST /api/v1/deploy — registers a new version of the named agent. */
  deployAgent(input: DeployAgentInput): Promise<AgentDeployRecord>
  /** POST /api/v1/agents/{name}/{task} — invokes a task, returns its result. */
  invokeAgentTask(
    name: string,
    task: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<unknown>
}

/** Builds the agent helpers bound to a transport config. */
export function createAgentApi(config: HttpConfig): AgentApi {
  async function deployAgent(input: DeployAgentInput): Promise<AgentDeployRecord> {
    requireNonEmptyString(input.name, 'name')
    requireNonEmptyString(input.source, 'source')
    const result = await sendRequest<AgentDeployRecord>(config, {
      method: 'POST',
      path: '/api/v1/deploy',
      body: { source: input.source, agentName: input.name, manifest: input.manifest },
      // Each deploy registers a new version — never retried.
      idempotent: false
    })
    return result.data
  }

  async function invokeAgentTask(
    name: string,
    task: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    requireNonEmptyString(name, 'name')
    requireNonEmptyString(task, 'task')
    const result = await sendRequest<unknown>(config, {
      method: 'POST',
      path: `/api/v1/agents/${encodeURIComponent(name)}/${encodeURIComponent(task)}`,
      body: args,
      // A task invocation performs real work — never retried.
      idempotent: false
    })
    return result.data
  }

  return { deployAgent, invokeAgentTask }
}
