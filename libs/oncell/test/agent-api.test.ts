import { createOnCellClient } from '../src/client'
import { OnCellApiError, OnCellInputError } from '../src/errors'
import type { AgentManifest } from '../src/types'
import { createMockFetch, jsonResponse, sentBody } from './helpers/mock-fetch'

/**
 * Agent API tests: deployAgent and invokeAgentTask against the scripted
 * fetch mock — wire shapes, encoding, non-retry policy, and validation.
 */

const API_KEY = 'test-key'
const BASE_URL = 'https://oncell.test'

const MANIFEST: AgentManifest = {
  identity: {
    instructions: 'You are the builder for idea "acme".',
    model: 'claude-sonnet-5',
    budgets: { perDayCents: 500 }
  },
  capabilities: ['memory', 'cells', 'schedule'],
  skills: [
    {
      name: 'improve',
      description: 'Ship one user-felt improvement per iteration.',
      instructions: 'Read the app, pick one improvement, ship full files.',
      tools: ['cells', 'schedule']
    }
  ]
}

function clientWith(responses: Parameters<typeof createMockFetch>[0]) {
  const mock = createMockFetch(responses)
  const client = createOnCellClient({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    fetchImpl: mock.fetchImpl,
    retryBackoffMs: 1
  })
  return { client, mock }
}

describe('deployAgent', () => {
  test('POSTs source, agentName, and manifest to /api/v1/deploy', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(200, { agentName: 'builder-acme', version: 3, url: 'https://api.oncell.ai/api/v1/agents/builder-acme' })
    ])

    // Act
    const record = await client.deployAgent({
      name: 'builder-acme',
      source: 'export default agent',
      manifest: MANIFEST
    })

    // Assert
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/deploy`)
    expect(mock.calls[0].init.method).toBe('POST')
    expect(mock.calls[0].init.headers['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(sentBody(mock.calls[0])).toEqual({
      source: 'export default agent',
      agentName: 'builder-acme',
      manifest: MANIFEST
    })
    expect(record.agentName).toBe('builder-acme')
    expect(record.version).toBe(3)
  })

  test('never retries a deploy on a transient 503', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'host resuming' }),
      jsonResponse(200, { agentName: 'builder-acme', version: 1 })
    ])

    // Act + Assert
    await expect(
      client.deployAgent({ name: 'builder-acme', source: 'src', manifest: MANIFEST })
    ).rejects.toThrow(OnCellApiError)
    expect(mock.calls).toHaveLength(1)
  })

  test('rejects an empty agent name without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(
      client.deployAgent({ name: '', source: 'src', manifest: MANIFEST })
    ).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('rejects empty source without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(
      client.deployAgent({ name: 'builder-acme', source: '', manifest: MANIFEST })
    ).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })
})

describe('invokeAgentTask', () => {
  test('POSTs the args to /api/v1/agents/{name}/{task}', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { run: 'run-1', status: 'completed' })])

    // Act
    const result = await client.invokeAgentTask('builder-acme', 'build', {
      cell_id: 'dev--v-acme',
      run: 'run-1'
    })

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/agents/builder-acme/build`)
    expect(sentBody(mock.calls[0])).toEqual({ cell_id: 'dev--v-acme', run: 'run-1' })
    expect(result).toEqual({ run: 'run-1', status: 'completed' })
  })

  test('URL-encodes agent and task path segments', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act
    await client.invokeAgentTask('builder/x', 'do it', {})

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/agents/builder%2Fx/do%20it`)
  })

  test('never retries an invocation on a transient 502', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(502, { error: 'bad gateway' }),
      jsonResponse(200, {})
    ])

    // Act + Assert
    await expect(client.invokeAgentTask('builder-acme', 'improve', {})).rejects.toThrow(
      OnCellApiError
    )
    expect(mock.calls).toHaveLength(1)
  })

  test('surfaces the normalized API error from a failed invocation', async () => {
    // Arrange
    const { client } = clientWith([
      jsonResponse(404, { error: { code: 'AGENT_NOT_FOUND', message: 'no such agent' } })
    ])

    // Act
    const failure = await client
      .invokeAgentTask('builder-ghost', 'build', {})
      .then(() => undefined)
      .catch((error: unknown) => error)

    // Assert
    expect(failure).toBeInstanceOf(OnCellApiError)
    expect((failure as OnCellApiError).status).toBe(404)
    expect((failure as OnCellApiError).code).toBe('AGENT_NOT_FOUND')
  })

  test('rejects an empty task name without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(client.invokeAgentTask('builder-acme', '', {})).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })
})
