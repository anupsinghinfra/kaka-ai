import { createOnCellClient } from '../src/client'
import { OnCellApiError, OnCellInputError } from '../src/errors'
import { createMockFetch, jsonResponse, sentBody } from './helpers/mock-fetch'

/**
 * App service lifecycle: POST/GET/DELETE /api/v1/cells/{id}/service.
 * The endpoint uses 503 semantically (NO_APP_RUNNING until started), so
 * these calls must never trigger the transport's transient-503 retry.
 */

const API_KEY = 'test-key'
const BASE_URL = 'https://oncell.test'
const SERVICE = { running: true, port: 3000, cmd: 'node src/server.js' }
const NO_APP_RUNNING = {
  error: { code: 'NO_APP_RUNNING', message: 'no app service is running in this cell' }
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

describe('startService', () => {
  test('posts the cmd to the service path and returns the record', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, SERVICE)])

    // Act
    const record = await client.startService('dev--cust', { cmd: 'node src/server.js' })

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/service`)
    expect(mock.calls[0].init.method).toBe('POST')
    expect(sentBody(mock.calls[0])).toEqual({ cmd: 'node src/server.js' })
    expect(record).toEqual(SERVICE)
  })

  test('includes env when provided', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, SERVICE)])

    // Act
    await client.startService('dev--cust', {
      cmd: 'node src/server.js',
      env: { NODE_ENV: 'production' }
    })

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({
      cmd: 'node src/server.js',
      env: { NODE_ENV: 'production' }
    })
  })

  test('rejects an empty cmd without calling the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, SERVICE)])

    // Act + Assert
    await expect(client.startService('dev--cust', { cmd: '' })).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('does not retry a 503 (the status is semantic, not transient)', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, NO_APP_RUNNING),
      jsonResponse(201, SERVICE)
    ])

    // Act
    const failure = client.startService('dev--cust', { cmd: 'node src/server.js' })

    // Assert — surfaced immediately, single call.
    await expect(failure).rejects.toBeInstanceOf(OnCellApiError)
    expect(mock.calls).toHaveLength(1)
  })
})

describe('getService', () => {
  test('issues GET to the service path and returns the record', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, SERVICE)])

    // Act
    const record = await client.getService('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/service`)
    expect(mock.calls[0].init.method).toBe('GET')
    expect(record.running).toBe(true)
    expect(record.port).toBe(3000)
  })

  test('surfaces NO_APP_RUNNING as a normalized error without retrying', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(503, NO_APP_RUNNING)])

    // Act
    const failure = client.getService('dev--cust')

    // Assert
    await expect(failure).rejects.toMatchObject({
      name: 'OnCellApiError',
      status: 503,
      code: 'NO_APP_RUNNING'
    })
    expect(mock.calls).toHaveLength(1)
  })
})

describe('stopService', () => {
  test('issues DELETE to the service path and tolerates an empty body', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(204, undefined)])

    // Act
    await client.stopService('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/service`)
    expect(mock.calls[0].init.method).toBe('DELETE')
  })

  test('surfaces NO_APP_RUNNING when nothing is running', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(503, NO_APP_RUNNING)])

    // Act + Assert — callers decide whether "nothing running" is fine.
    await expect(client.stopService('dev--cust')).rejects.toMatchObject({
      code: 'NO_APP_RUNNING',
      status: 503
    })
  })
})
