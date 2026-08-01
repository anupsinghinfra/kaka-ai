import { createOnCellClient } from '../src/client'
import { OnCellApiError, OnCellInputError } from '../src/errors'
import { createMockFetch, jsonResponse } from './helpers/mock-fetch'

/**
 * Agent-runs API tests: getLatestAgentRun and getAgentRunFeed against the
 * scripted fetch mock — URLs, cursor semantics, page normalization, the
 * idempotent-read retry, and input validation.
 */

const API_KEY = 'test-key'
const BASE_URL = 'https://oncell.test'

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

describe('getLatestAgentRun', () => {
  test('GETs /runs/latest and returns the run record', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(200, { runId: 'run-7', startedAt: '2026-08-01T02:00:00.000Z', active: true })
    ])

    // Act
    const run = await client.getLatestAgentRun('builder-acme')

    // Assert
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/agents/builder-acme/runs/latest`)
    expect(mock.calls[0].init.method).toBe('GET')
    expect(mock.calls[0].init.headers['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(run).toEqual({ runId: 'run-7', startedAt: '2026-08-01T02:00:00.000Z', active: true })
  })

  test('URL-encodes the agent name', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(200, { runId: 'r', startedAt: 't', active: false })
    ])

    // Act
    await client.getLatestAgentRun('builder/x')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/agents/builder%2Fx/runs/latest`)
  })

  test('retries once on a transient 503 — reads are idempotent', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'host resuming' }),
      jsonResponse(200, { runId: 'run-7', startedAt: 't', active: true })
    ])

    // Act
    const run = await client.getLatestAgentRun('builder-acme')

    // Assert
    expect(mock.calls).toHaveLength(2)
    expect(run.runId).toBe('run-7')
  })

  test('surfaces a 404 while the run is spinning up as OnCellApiError', async () => {
    // Arrange
    const { client } = clientWith([
      jsonResponse(404, { error: { code: 'NO_RUNS', message: 'agent has no runs yet' } })
    ])

    // Act
    const failure = await client
      .getLatestAgentRun('builder-acme')
      .then(() => undefined)
      .catch((error: unknown) => error)

    // Assert
    expect(failure).toBeInstanceOf(OnCellApiError)
    expect((failure as OnCellApiError).status).toBe(404)
  })

  test('rejects an empty agent name without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(client.getLatestAgentRun('')).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })
})

describe('getAgentRunFeed', () => {
  const ENTRY = {
    idx: 0,
    ts: '2026-08-01T02:00:01.000Z',
    op: 'cells_write_file',
    summary: 'cells_write_file src/server.js'
  }

  test('GETs the feed page with the after cursor', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(200, { entries: [ENTRY], next: 1, done: false })
    ])

    // Act
    const page = await client.getAgentRunFeed('builder-acme', 'run-7', 0)

    // Assert
    expect(mock.calls[0].url).toBe(
      `${BASE_URL}/api/v1/agents/builder-acme/runs/run-7/feed?after=0`
    )
    expect(mock.calls[0].init.method).toBe('GET')
    expect(page).toEqual({ entries: [ENTRY], next: 1, done: false })
  })

  test('defaults after to 0 and URL-encodes both path segments', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { entries: [], next: 0, done: false })])

    // Act
    await client.getAgentRunFeed('builder/x', 'run 7')

    // Assert
    expect(mock.calls[0].url).toBe(
      `${BASE_URL}/api/v1/agents/builder%2Fx/runs/run%207/feed?after=0`
    )
  })

  test('falls back to after + entries.length when next is missing', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, { entries: [ENTRY, ENTRY], done: true })])

    // Act
    const page = await client.getAgentRunFeed('builder-acme', 'run-7', 5)

    // Assert
    expect(page.next).toBe(7)
    expect(page.done).toBe(true)
  })

  test('coerces a missing done flag to false', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, { entries: [], next: 3 })])

    // Act
    const page = await client.getAgentRunFeed('builder-acme', 'run-7', 3)

    // Assert
    expect(page.done).toBe(false)
  })

  test('throws UNEXPECTED_RESPONSE when entries is not an array', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, { next: 0, done: false })])

    // Act
    const failure = await client
      .getAgentRunFeed('builder-acme', 'run-7', 0)
      .then(() => undefined)
      .catch((error: unknown) => error)

    // Assert
    expect(failure).toBeInstanceOf(OnCellApiError)
    expect((failure as OnCellApiError).code).toBe('UNEXPECTED_RESPONSE')
  })

  test('retries once on a transient 502 — reads are idempotent', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(502, { error: 'bad gateway' }),
      jsonResponse(200, { entries: [], next: 0, done: false })
    ])

    // Act
    const page = await client.getAgentRunFeed('builder-acme', 'run-7', 0)

    // Assert
    expect(mock.calls).toHaveLength(2)
    expect(page.entries).toEqual([])
  })

  test('rejects an empty runId without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(client.getAgentRunFeed('builder-acme', '', 0)).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('rejects a negative or non-integer after without hitting the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(client.getAgentRunFeed('builder-acme', 'run-7', -1)).rejects.toThrow(
      OnCellInputError
    )
    await expect(client.getAgentRunFeed('builder-acme', 'run-7', 1.5)).rejects.toThrow(
      OnCellInputError
    )
    expect(mock.calls).toHaveLength(0)
  })
})
