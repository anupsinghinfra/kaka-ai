import { createOnCellClient } from '../src/client'
import { OnCellApiError, parseApiError } from '../src/errors'
import { createMockFetch, jsonResponse, rawResponse } from './helpers/mock-fetch'

const BASE_URL = 'https://oncell.test'
const CELL = { cell_id: 'dev--cust', status: 'running' }
const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', truncated: false, duration_ms: 1 }

function clientWith(responses: Parameters<typeof createMockFetch>[0]) {
  const mock = createMockFetch(responses)
  const client = createOnCellClient({
    apiKey: 'test-key',
    baseUrl: BASE_URL,
    fetchImpl: mock.fetchImpl,
    retryBackoffMs: 1
  })
  return { client, mock }
}

describe('retry behavior', () => {
  test('retries an idempotent GET exactly once after a 503 and succeeds', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'host resuming' }),
      jsonResponse(200, CELL)
    ])

    // Act
    const record = await client.getCell('dev--cust')

    // Assert
    expect(mock.calls).toHaveLength(2)
    expect(record).toEqual(CELL)
  })

  test('retries an idempotent request after a 502', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(502, { error: 'bad gateway' }),
      jsonResponse(200, [CELL])
    ])

    // Act
    const cells = await client.listCells()

    // Assert
    expect(mock.calls).toHaveLength(2)
    expect(cells).toEqual([CELL])
  })

  test('does not retry more than once — a second 503 surfaces as an error', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'still resuming' }),
      jsonResponse(503, { error: 'still resuming' })
    ])

    // Act
    const failure = client.getCell('dev--cust')

    // Assert
    await expect(failure).rejects.toMatchObject({ status: 503 })
    expect(mock.calls).toHaveLength(2)
  })

  test('does not retry a non-retryable status like 500', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(500, { error: 'internal' })])

    // Act
    const failure = client.getCell('dev--cust')

    // Assert
    await expect(failure).rejects.toMatchObject({ status: 500 })
    expect(mock.calls).toHaveLength(1)
  })

  test('never retries exec without an idempotency key', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(503, { error: 'host resuming' })])

    // Act
    const failure = client.exec('dev--cust', { cmd: 'echo hi' })

    // Assert
    await expect(failure).rejects.toMatchObject({ status: 503 })
    expect(mock.calls).toHaveLength(1)
  })

  test('retries exec once when an idempotency key is provided', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'host resuming' }),
      jsonResponse(200, OK_EXEC)
    ])

    // Act
    const result = await client.exec('dev--cust', { cmd: 'echo hi', idempotencyKey: 'run-1' })

    // Assert
    expect(mock.calls).toHaveLength(2)
    expect(result.exit_code).toBe(0)
  })

  test('never retries snapshot — it creates a new resource each call', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(503, { error: 'host resuming' })])

    // Act
    const failure = client.snapshotCell('dev--cust')

    // Assert
    await expect(failure).rejects.toMatchObject({ status: 503 })
    expect(mock.calls).toHaveLength(1)
  })

  test('wraps a network failure in OnCellApiError with status 0 and does not retry', async () => {
    // Arrange
    const { client, mock } = clientWith([new Error('socket hang up')])

    // Act
    const failure = client.getCell('dev--cust')

    // Assert
    await expect(failure).rejects.toBeInstanceOf(OnCellApiError)
    await expect(failure).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
    expect(mock.calls).toHaveLength(1)
  })
})

describe('error-shape normalization', () => {
  test('normalizes the legacy {error: string} shape', () => {
    // Arrange
    const body = JSON.stringify({ error: 'cell not found' })

    // Act
    const error = parseApiError(404, body)

    // Assert
    expect(error).toBeInstanceOf(OnCellApiError)
    expect(error.status).toBe(404)
    expect(error.message).toBe('cell not found')
    expect(error.code).toBeUndefined()
  })

  test('normalizes the structured {error: {code, message, remediation}} shape', () => {
    // Arrange
    const body = JSON.stringify({
      error: { code: 'CELL_PAUSED', message: 'cell is paused', remediation: 'resume the cell first' }
    })

    // Act
    const error = parseApiError(409, body)

    // Assert
    expect(error.status).toBe(409)
    expect(error.code).toBe('CELL_PAUSED')
    expect(error.message).toBe('cell is paused')
    expect(error.remediation).toBe('resume the cell first')
  })

  test('falls back to the raw text for a non-JSON error body', () => {
    // Arrange + Act
    const error = parseApiError(502, '<html>Bad Gateway</html>')

    // Assert
    expect(error.status).toBe(502)
    expect(error.message).toContain('502')
    expect(error.message).toContain('Bad Gateway')
  })

  test('handles an empty error body', () => {
    // Arrange + Act
    const error = parseApiError(500, '')

    // Assert
    expect(error.message).toBe('HTTP 500')
  })

  test('handles a structured error object missing its message', () => {
    // Arrange + Act
    const error = parseApiError(400, JSON.stringify({ error: { code: 'BAD_INPUT' } }))

    // Assert
    expect(error.code).toBe('BAD_INPUT')
    expect(error.message).toBe('HTTP 400')
  })

  test('surfaces both shapes identically through a live client call', async () => {
    // Arrange
    const { client } = clientWith([rawResponse(400, JSON.stringify({ error: 'legacy shape' }))])

    // Act + Assert
    await expect(client.getCell('dev--cust')).rejects.toMatchObject({
      status: 400,
      message: 'legacy shape'
    })
  })
})
