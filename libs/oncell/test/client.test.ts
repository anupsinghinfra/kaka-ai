import { createOnCellClient, DEFAULT_ONCELL_API_URL } from '../src/client'
import { OnCellApiError, OnCellConfigError, OnCellInputError } from '../src/errors'
import { createMockFetch, jsonResponse, sentBody } from './helpers/mock-fetch'

const API_KEY = 'test-key'
const BASE_URL = 'https://oncell.test'
const CELL = { cell_id: 'dev--cust', status: 'running' }

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

describe('createOnCellClient configuration', () => {
  const savedKey = process.env.ONCELL_API_KEY
  const savedUrl = process.env.ONCELL_API_URL

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ONCELL_API_KEY
    else process.env.ONCELL_API_KEY = savedKey
    if (savedUrl === undefined) delete process.env.ONCELL_API_URL
    else process.env.ONCELL_API_URL = savedUrl
  })

  test('throws OnCellConfigError when no API key is provided or in env', () => {
    // Arrange
    delete process.env.ONCELL_API_KEY

    // Act + Assert
    expect(() => createOnCellClient()).toThrow(OnCellConfigError)
  })

  test('falls back to ONCELL_API_KEY and ONCELL_API_URL from env', async () => {
    // Arrange
    process.env.ONCELL_API_KEY = 'env-key'
    process.env.ONCELL_API_URL = 'https://env.oncell.test/'
    const mock = createMockFetch([jsonResponse(200, CELL)])

    // Act
    const client = createOnCellClient({ fetchImpl: mock.fetchImpl })
    await client.getCell('dev--cust')

    // Assert (trailing slash stripped, env key used)
    expect(mock.calls[0].url).toBe('https://env.oncell.test/api/v1/cells/dev--cust')
    expect(mock.calls[0].init.headers['authorization']).toBe('Bearer env-key')
  })

  test('defaults the base URL to the production endpoint', async () => {
    // Arrange
    delete process.env.ONCELL_API_URL
    const mock = createMockFetch([jsonResponse(200, CELL)])
    const client = createOnCellClient({ apiKey: API_KEY, fetchImpl: mock.fetchImpl })

    // Act
    await client.getCell('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${DEFAULT_ONCELL_API_URL}/api/v1/cells/dev--cust`)
  })
})

describe('cell lifecycle verbs', () => {
  test('createCell posts snake_case body and returns the cell record', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, CELL)])

    // Act
    const record = await client.createCell({
      customerId: 'cust',
      tier: 'starter',
      snapshotKey: 'snap-1'
    })

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells`)
    expect(mock.calls[0].init.method).toBe('POST')
    expect(sentBody(mock.calls[0])).toEqual({
      customer_id: 'cust',
      tier: 'starter',
      snapshot_key: 'snap-1'
    })
    expect(record).toEqual(CELL)
  })

  test('createCell omits optional fields that were not provided', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, CELL)])

    // Act
    await client.createCell({ customerId: 'cust' })

    // Assert
    expect(sentBody(mock.calls[0])).toEqual({ customer_id: 'cust' })
  })

  test('createCell rejects an empty customerId without calling the network', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(201, CELL)])

    // Act + Assert
    await expect(client.createCell({ customerId: '' })).rejects.toThrow(OnCellInputError)
    expect(mock.calls).toHaveLength(0)
  })

  test('getCell issues GET to the cell path with the bearer header', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(200, CELL)])

    // Act
    const record = await client.getCell('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust`)
    expect(mock.calls[0].init.method).toBe('GET')
    expect(mock.calls[0].init.headers['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(record.cell_id).toBe('dev--cust')
  })

  test('listCells accepts a bare array response', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, [CELL])])

    // Act
    const cells = await client.listCells()

    // Assert
    expect(cells).toEqual([CELL])
  })

  test('listCells accepts a {cells: [...]} envelope', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, { cells: [CELL] })])

    // Act
    const cells = await client.listCells()

    // Assert
    expect(cells).toEqual([CELL])
  })

  test('listCells throws OnCellApiError on an unexpected response shape', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(200, { nope: true })])

    // Act + Assert
    await expect(client.listCells()).rejects.toMatchObject({
      name: 'OnCellApiError',
      code: 'UNEXPECTED_RESPONSE'
    })
  })

  test('deleteCell issues DELETE and tolerates an empty body', async () => {
    // Arrange
    const { client, mock } = clientWith([jsonResponse(204, undefined)])

    // Act
    await client.deleteCell('dev--cust')

    // Assert
    expect(mock.calls[0].init.method).toBe('DELETE')
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust`)
  })

  test('pauseCell and resumeCell post to their lifecycle paths', async () => {
    // Arrange
    const { client, mock } = clientWith([
      jsonResponse(200, { ...CELL, status: 'paused' }),
      jsonResponse(200, CELL)
    ])

    // Act
    const paused = await client.pauseCell('dev--cust')
    const resumed = await client.resumeCell('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/pause`)
    expect(mock.calls[1].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/resume`)
    expect(paused.status).toBe('paused')
    expect(resumed.status).toBe('running')
  })

  test('snapshotCell posts and returns the snapshot record', async () => {
    // Arrange
    const snapshot = { snapshot_key: 'snap-9', size_bytes: 42, created_at: '2026-08-01T00:00:00Z' }
    const { client, mock } = clientWith([jsonResponse(201, snapshot)])

    // Act
    const record = await client.snapshotCell('dev--cust')

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/snapshot`)
    expect(record.snapshot_key).toBe('snap-9')
  })

  test('listSnapshots accepts a {snapshots: [...]} envelope', async () => {
    // Arrange
    const snapshot = { snapshot_key: 'snap-9' }
    const { client } = clientWith([jsonResponse(200, { snapshots: [snapshot] })])

    // Act
    const snapshots = await client.listSnapshots('dev--cust')

    // Assert
    expect(snapshots).toEqual([snapshot])
  })

  test('forkCell posts the new customer_id and returns the forked record', async () => {
    // Arrange
    const fork = { ...CELL, cell_id: 'dev--cust-branch', forked_from: 'dev--cust' }
    const { client, mock } = clientWith([jsonResponse(201, fork)])

    // Act
    const record = await client.forkCell('dev--cust', { customerId: 'cust-branch' })

    // Assert
    expect(mock.calls[0].url).toBe(`${BASE_URL}/api/v1/cells/dev--cust/fork`)
    expect(sentBody(mock.calls[0])).toEqual({ customer_id: 'cust-branch' })
    expect(record.forked_from).toBe('dev--cust')
  })

  test('surfaces normalized API errors from lifecycle calls', async () => {
    // Arrange
    const { client } = clientWith([jsonResponse(404, { error: 'cell not found' })])

    // Act
    const failure = client.getCell('dev--missing')

    // Assert
    await expect(failure).rejects.toBeInstanceOf(OnCellApiError)
    await expect(failure).rejects.toMatchObject({ status: 404, message: 'cell not found' })
  })
})
