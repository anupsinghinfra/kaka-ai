import { createOnCellClient } from '../src/client'
import { OnCellInputError } from '../src/errors'
import { createMockFetch, jsonResponse, sentBody } from './helpers/mock-fetch'

const BASE_URL = 'https://oncell.test'
const REQUEST_URL = `${BASE_URL}/api/v1/cells/dev--cust/request`

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

describe('request helpers', () => {
  test('writeFile sends a write_file request with path and content', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { ok: true })])

    // Act
    await client.writeFile('dev--cust', 'src/app.js', 'module.exports = 1')

    // Assert
    expect(mock.calls[0].url).toBe(REQUEST_URL)
    expect(sentBody(mock.calls[0])).toEqual({
      method: 'write_file',
      params: { path: 'src/app.js', content: 'module.exports = 1' }
    })
  })

  test('writeFile rejects non-string content without a network call', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { ok: true })])

    // Act + Assert
    await expect(
      client.writeFile('dev--cust', 'a.txt', 42 as unknown as string)
    ).rejects.toThrow(TypeError)
    expect(mock.calls).toHaveLength(0)
  })

  test('readFile sends a read_file request and returns the result', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { content: 'hello' })])

    // Act
    const result = await client.readFile('dev--cust', 'data/notes.txt')

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({
      method: 'read_file',
      params: { path: 'data/notes.txt' }
    })
    expect(result.content).toBe('hello')
  })

  test('listFiles includes path only when provided', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { files: [] })])

    // Act
    await client.listFiles('dev--cust')
    await client.listFiles('dev--cust', 'src')

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({ method: 'list_files', params: {} })
    expect(sentBody(mock.calls[1])).toEqual({ method: 'list_files', params: { path: 'src' } })
  })

  test('kvGet sends db_get with the key', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { value: '1' })])

    // Act
    const result = await client.kvGet('dev--cust', 'version')

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({ method: 'db_get', params: { key: 'version' } })
    expect(result.value).toBe('1')
  })

  test('kvSet sends db_set with key and value', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { ok: true })])

    // Act
    await client.kvSet('dev--cust', 'version', '1')

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({
      method: 'db_set',
      params: { key: 'version', value: '1' }
    })
  })

  test('kvGet rejects an empty key', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act + Assert
    await expect(client.kvGet('dev--cust', '')).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('journal, logs, and metrics map to their request methods', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, {})])

    // Act
    await client.journal('dev--cust')
    await client.logs('dev--cust', 50)
    await client.logs('dev--cust')
    await client.metrics('dev--cust')

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({ method: 'journal', params: {} })
    expect(sentBody(mock.calls[1])).toEqual({ method: 'logs', params: { lines: 50 } })
    expect(sentBody(mock.calls[2])).toEqual({ method: 'logs', params: {} })
    expect(sentBody(mock.calls[3])).toEqual({ method: 'metrics', params: {} })
  })

  test('raw request passes an arbitrary method and params through', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, { rows: [] })])

    // Act
    const result = await client.request<{ rows: readonly unknown[] }>('dev--cust', 'db_get', {
      key: 'anything'
    })

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({ method: 'db_get', params: { key: 'anything' } })
    expect(result.rows).toEqual([])
  })

  test('request helpers retry once on 503 (write_file is an idempotent overwrite)', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(503, { error: 'host resuming' }),
      jsonResponse(200, { ok: true })
    ])

    // Act
    await client.writeFile('dev--cust', 'a.txt', 'same content')

    // Assert
    expect(mock.calls).toHaveLength(2)
  })
})
