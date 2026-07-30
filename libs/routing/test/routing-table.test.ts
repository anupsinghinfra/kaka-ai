import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
  ResourceNotFoundException
} from '@aws-sdk/client-cloudfront-keyvaluestore'
import { mockClient } from 'aws-sdk-client-mock'
import { pino } from 'pino'
import {
  HostnameValidationError,
  KeyValueStoreError,
  KvsArnValidationError,
  RouteConflictError,
  TargetValidationError
} from '../src/errors'
import { createRoutingTable, type RoutingTable } from '../src/routing-table'

const KVS_ARN = 'arn:aws:cloudfront::111111111111:key-value-store/2f4e6a1c-0000-1111-2222-333344445555'
const HOSTNAME = 'deploy-1.venture.example.app'
const TARGET = 'cell-abc.ingress.internal:8443'

const kvsMock = mockClient(CloudFrontKeyValueStoreClient)
const silentLogger = pino({ level: 'silent' })

function buildRoutingTable(): RoutingTable {
  return createRoutingTable({
    kvsArn: KVS_ARN,
    client: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
    logger: silentLogger
  })
}

function conflictError(): ConflictException {
  return new ConflictException({ message: 'Pre-condition failed', $metadata: {} })
}

function notFoundError(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'Resource was not found', $metadata: {} })
}

beforeEach(() => {
  kvsMock.reset()
})

describe('createRoutingTable', () => {
  test('rejects a malformed KeyValueStore ARN with a remediation hint', () => {
    // Act
    let thrown: unknown
    try {
      createRoutingTable({ kvsArn: 'not-an-arn', logger: silentLogger })
    } catch (error: unknown) {
      thrown = error
    }

    // Assert
    expect(thrown).toBeInstanceOf(KvsArnValidationError)
    expect((thrown as KvsArnValidationError).hint).toContain('/platform/network/routing-table-kvs-arn')
  })
})

describe('putRoute', () => {
  test('writes the route with the ETag from DescribeKeyValueStore', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-1' })
    kvsMock.on(PutKeyCommand).resolves({})
    const table = buildRoutingTable()

    // Act
    await table.putRoute(HOSTNAME, TARGET)

    // Assert
    const putCalls = kvsMock.commandCalls(PutKeyCommand)
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].args[0].input).toEqual({
      KvsARN: KVS_ARN,
      Key: HOSTNAME,
      Value: TARGET,
      IfMatch: 'etag-1'
    })
  })

  test('normalizes the hostname before writing', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-1' })
    kvsMock.on(PutKeyCommand).resolves({})
    const table = buildRoutingTable()

    // Act
    await table.putRoute('  Deploy-1.Venture.EXAMPLE.APP  ', TARGET)

    // Assert
    expect(kvsMock.commandCalls(PutKeyCommand)[0].args[0].input.Key).toBe(HOSTNAME)
  })

  test('refreshes the ETag and retries once after a conflict', async () => {
    // Arrange
    kvsMock
      .on(DescribeKeyValueStoreCommand)
      .resolvesOnce({ ETag: 'etag-stale' })
      .resolvesOnce({ ETag: 'etag-fresh' })
    kvsMock.on(PutKeyCommand).rejectsOnce(conflictError()).resolvesOnce({})
    const table = buildRoutingTable()

    // Act
    await table.putRoute(HOSTNAME, TARGET)

    // Assert
    const putCalls = kvsMock.commandCalls(PutKeyCommand)
    expect(putCalls).toHaveLength(2)
    expect(putCalls[0].args[0].input.IfMatch).toBe('etag-stale')
    expect(putCalls[1].args[0].input.IfMatch).toBe('etag-fresh')
    expect(kvsMock.commandCalls(DescribeKeyValueStoreCommand)).toHaveLength(2)
  })

  test('throws RouteConflictError when the retry also conflicts', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-any' })
    kvsMock.on(PutKeyCommand).rejects(conflictError())
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.putRoute(HOSTNAME, TARGET)).rejects.toThrow(RouteConflictError)
    expect(kvsMock.commandCalls(PutKeyCommand)).toHaveLength(2)
  })

  test('wraps non-conflict KVS failures in KeyValueStoreError without retrying', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-1' })
    kvsMock.on(PutKeyCommand).rejects(new Error('access denied'))
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.putRoute(HOSTNAME, TARGET)).rejects.toThrow(KeyValueStoreError)
    expect(kvsMock.commandCalls(PutKeyCommand)).toHaveLength(1)
  })

  test('throws KeyValueStoreError when Describe returns no ETag', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({})
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.putRoute(HOSTNAME, TARGET)).rejects.toThrow(KeyValueStoreError)
    expect(kvsMock.commandCalls(PutKeyCommand)).toHaveLength(0)
  })

  test.each([
    ['invalid hostname', 'not a hostname', TARGET, HostnameValidationError],
    ['invalid target', HOSTNAME, 'cell.internal:notaport', TargetValidationError]
  ])('rejects %s before any KVS call', async (_label, hostname, target, expectedError) => {
    // Arrange
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.putRoute(hostname, target)).rejects.toThrow(expectedError)
    expect(kvsMock.calls()).toHaveLength(0)
  })
})

describe('deleteRoute', () => {
  test('deletes the route with the current ETag', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-9' })
    kvsMock.on(DeleteKeyCommand).resolves({})
    const table = buildRoutingTable()

    // Act
    await table.deleteRoute(HOSTNAME)

    // Assert
    const deleteCalls = kvsMock.commandCalls(DeleteKeyCommand)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].args[0].input).toEqual({
      KvsARN: KVS_ARN,
      Key: HOSTNAME,
      IfMatch: 'etag-9'
    })
  })

  test('treats deleting an absent route as success (idempotent)', async () => {
    // Arrange
    kvsMock.on(DescribeKeyValueStoreCommand).resolves({ ETag: 'etag-9' })
    kvsMock.on(DeleteKeyCommand).rejects(notFoundError())
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.deleteRoute(HOSTNAME)).resolves.toBeUndefined()
  })

  test('refreshes the ETag and retries once after a conflict', async () => {
    // Arrange
    kvsMock
      .on(DescribeKeyValueStoreCommand)
      .resolvesOnce({ ETag: 'etag-stale' })
      .resolvesOnce({ ETag: 'etag-fresh' })
    kvsMock.on(DeleteKeyCommand).rejectsOnce(conflictError()).resolvesOnce({})
    const table = buildRoutingTable()

    // Act
    await table.deleteRoute(HOSTNAME)

    // Assert
    const deleteCalls = kvsMock.commandCalls(DeleteKeyCommand)
    expect(deleteCalls).toHaveLength(2)
    expect(deleteCalls[1].args[0].input.IfMatch).toBe('etag-fresh')
  })
})

describe('getRoute', () => {
  test('returns the stored target for a known hostname', async () => {
    // Arrange
    kvsMock.on(GetKeyCommand).resolves({ Key: HOSTNAME, Value: TARGET })
    const table = buildRoutingTable()

    // Act
    const route = await table.getRoute(HOSTNAME)

    // Assert
    expect(route).toBe(TARGET)
    expect(kvsMock.commandCalls(GetKeyCommand)[0].args[0].input).toEqual({
      KvsARN: KVS_ARN,
      Key: HOSTNAME
    })
  })

  test('returns null when the hostname has no route', async () => {
    // Arrange
    kvsMock.on(GetKeyCommand).rejects(notFoundError())
    const table = buildRoutingTable()

    // Act
    const route = await table.getRoute(HOSTNAME)

    // Assert
    expect(route).toBeNull()
  })

  test('wraps other KVS failures in KeyValueStoreError', async () => {
    // Arrange
    kvsMock.on(GetKeyCommand).rejects(new Error('throttled'))
    const table = buildRoutingTable()

    // Act + Assert
    await expect(table.getRoute(HOSTNAME)).rejects.toThrow(KeyValueStoreError)
  })
})
