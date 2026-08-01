import { createOnCellClient } from '../src/client'
import { OnCellExecError, OnCellInputError } from '../src/errors'
import { MAX_CMD_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_TIMEOUT_MS } from '../src/validate'
import { createMockFetch, jsonResponse, sentBody } from './helpers/mock-fetch'

const BASE_URL = 'https://oncell.test'
const OK_EXEC = { exit_code: 0, stdout: 'hello\n', stderr: '', truncated: false, duration_ms: 12 }

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

describe('exec', () => {
  test('maps camelCase input to the wire body and returns the typed result', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act
    const result = await client.exec('dev--cust', {
      cmd: 'echo hello',
      timeoutMs: 30_000,
      idempotencyKey: 'run-1'
    })

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/exec`)
    expect(sentBody(mock.calls[0])).toEqual({
      cmd: 'echo hello',
      timeout_ms: 30_000,
      idempotency_key: 'run-1'
    })
    expect(result).toEqual({ ...OK_EXEC, replayed: false })
  })

  test('sets replayed=true when the server answers with x-idempotent-replay', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, OK_EXEC, { 'x-idempotent-replay': 'true' })])

    // Act
    const result = await client.exec('dev--cust', { cmd: 'echo hello', idempotencyKey: 'run-1' })

    // Assert
    expect(result.replayed).toBe(true)
  })

  test('throws OnCellExecError with stdout and stderr context when expectSuccess and exit is non-zero', async () => {
    // Arrange
    const failed = { exit_code: 2, stdout: 'partial out', stderr: 'boom', truncated: false, duration_ms: 5 }
    const { client } = clientWith([jsonResponse(200, failed)])

    // Act
    const failure = client.exec('dev--cust', { cmd: 'node crash.js', expectSuccess: true })

    // Assert
    await expect(failure).rejects.toBeInstanceOf(OnCellExecError)
    await expect(failure).rejects.toMatchObject({
      exitCode: 2,
      stdout: 'partial out',
      stderr: 'boom',
      cmd: 'node crash.js'
    })
  })

  test('returns the failed result without throwing when expectSuccess is not set', async () => {
    // Arrange
    const failed = { exit_code: 1, stdout: '', stderr: 'nope', truncated: false, duration_ms: 3 }
    const { client } = clientWith([jsonResponse(200, failed)])

    // Act
    const result = await client.exec('dev--cust', { cmd: 'false' })

    // Assert
    expect(result.exit_code).toBe(1)
  })

  test('rejects an empty cmd', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act + Assert
    await expect(client.exec('dev--cust', { cmd: '' })).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('rejects a cmd longer than the API limit', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act + Assert
    await expect(
      client.exec('dev--cust', { cmd: 'x'.repeat(MAX_CMD_LENGTH + 1) })
    ).rejects.toThrow(OnCellInputError)
  })

  test('rejects a timeout above the API maximum', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act + Assert
    await expect(
      client.exec('dev--cust', { cmd: 'echo hi', timeoutMs: MAX_TIMEOUT_MS + 1 })
    ).rejects.toThrow(OnCellInputError)
  })

  test('rejects a non-positive or non-integer timeout', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act + Assert
    await expect(client.exec('dev--cust', { cmd: 'echo hi', timeoutMs: 0 })).rejects.toThrow(
      OnCellInputError
    )
    await expect(client.exec('dev--cust', { cmd: 'echo hi', timeoutMs: 1.5 })).rejects.toThrow(
      OnCellInputError
    )
  })

  test('rejects an idempotency key outside 1..128 characters', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, OK_EXEC)])

    // Act + Assert
    await expect(client.exec('dev--cust', { cmd: 'echo hi', idempotencyKey: '' })).rejects.toThrow(
      OnCellInputError
    )
    await expect(
      client.exec('dev--cust', {
        cmd: 'echo hi',
        idempotencyKey: 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)
      })
    ).rejects.toThrow(OnCellInputError)
  })
})
