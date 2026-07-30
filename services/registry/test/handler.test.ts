import { createPublisher, type EventBridgePutEventsClient } from '@platform/events'
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createRegistryHandler } from '../src/handler'
import { DynamoDbVentureRepository } from '../src/venture-store'
import type { HandlerDependencies, VentureRecord } from '../src/types'
import {
  FailingEventBridgeClient,
  FakeEventBridgeClient,
  FakeVenturesDynamoClient,
  generateTestKeyPair,
  makeEvent,
  mintCapabilityToken,
  silentLogger,
  validManifest,
  validManifestInput,
  type TestKeyPair
} from './helpers/fakes'

const keys: TestKeyPair = generateTestKeyPair()
const NOW = new Date('2026-07-29T12:00:00.000Z')
const VENTURE_ID = 'venture-test-0001'

interface SetupOverrides {
  readonly eventBridge?: EventBridgePutEventsClient
  readonly deps?: Partial<HandlerDependencies>
}

function setup(overrides: SetupOverrides = {}) {
  const dynamo = new FakeVenturesDynamoClient()
  const eventBridge = overrides.eventBridge ?? new FakeEventBridgeClient()
  const ventures = new DynamoDbVentureRepository(dynamo, 'ventures-test', 'ownerId-index')

  const deps: HandlerDependencies = {
    ventures,
    publisher: createPublisher({ busName: 'platform-bus-test', source: 'registry', client: eventBridge }),
    getVerificationKey: () => Promise.resolve(keys.publicKey),
    logger: silentLogger,
    now: () => NOW,
    generateVentureId: () => VENTURE_ID,
    ...overrides.deps
  }

  return { handler: createRegistryHandler(deps), dynamo, eventBridge }
}

function token(scopes: readonly string[], claimOverrides: Readonly<Record<string, unknown>> = {}): string {
  return mintCapabilityToken({ scopes, privateKey: keys.privateKey, claimOverrides })
}

function parseBody(result: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  expect(result.body).toBeDefined()
  return JSON.parse(result.body as string) as Record<string, unknown>
}

function expectErrorBody(
  result: APIGatewayProxyStructuredResultV2,
  statusCode: number,
  code: string
): Record<string, unknown> {
  expect(result.statusCode).toBe(statusCode)
  const error = parseBody(result)['error'] as Record<string, unknown>
  expect(error['code']).toBe(code)
  expect(typeof error['message']).toBe('string')
  expect(typeof error['remediation']).toBe('string')
  return error
}

function seededRecord(overrides: Partial<VentureRecord> = {}): Record<string, unknown> {
  return {
    ventureId: VENTURE_ID,
    ownerId: 'agent-orchestrator-1',
    status: 'active',
    version: 1,
    manifest: validManifest(VENTURE_ID),
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides
  }
}

describe('registry — authentication', () => {
  test('returns 401 MISSING_TOKEN when no Authorization header is present', async () => {
    // Arrange
    const { handler } = setup()

    // Act
    const result = await handler(makeEvent({ routeKey: 'POST /ventures', body: { manifest: validManifestInput() } }))

    // Assert
    expectErrorBody(result, 401, 'MISSING_TOKEN')
  })

  test('returns 401 MALFORMED_TOKEN for a garbage bearer token', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({ routeKey: 'POST /ventures', token: 'not-a-jwt', body: { manifest: validManifestInput() } })
    )

    expectErrorBody(result, 401, 'MALFORMED_TOKEN')
  })

  test('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const { handler } = setup()
    const nowSecs = Math.floor(NOW.getTime() / 1000)
    const expired = token(['venture:create'], { iat: nowSecs - 600, exp: nowSecs - 300 })

    const result = await handler(
      makeEvent({ routeKey: 'POST /ventures', token: expired, body: { manifest: validManifestInput() } })
    )

    expectErrorBody(result, 401, 'TOKEN_EXPIRED')
  })

  test('returns 500 INTERNAL_ERROR when the verification key cannot be resolved', async () => {
    const { handler } = setup({
      deps: { getVerificationKey: () => Promise.reject(new Error('KMS unavailable')) }
    })

    const result = await handler(
      makeEvent({ routeKey: 'POST /ventures', token: token(['venture:create']), body: { manifest: validManifestInput() } })
    )

    expectErrorBody(result, 500, 'INTERNAL_ERROR')
  })
})

describe('registry — authorization (deny by default)', () => {
  test('returns machine-readable 403 SCOPE_DENIED when creating without venture:create', async () => {
    // Arrange: a valid token, wrong scope (M0 exit criterion: unscoped call → 403)
    const { handler, eventBridge } = setup()

    // Act
    const result = await handler(
      makeEvent({
        routeKey: 'POST /ventures',
        token: token(['venture:read']),
        body: { manifest: validManifestInput() }
      })
    )

    // Assert
    const error = expectErrorBody(result, 403, 'SCOPE_DENIED')
    expect(error['remediation']).toContain('venture:create')
    expect((eventBridge as FakeEventBridgeClient).envelopes).toHaveLength(0)
  })

  test('a read scope for another venture does not grant reading this one', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read:venture-other']),
        pathParameters: { ventureId: VENTURE_ID }
      })
    )

    expectErrorBody(result, 403, 'SCOPE_DENIED')
  })

  test('a venture-scoped read grant does not cover the resource-less list scope', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({ routeKey: 'GET /ventures', token: token([`venture:read:${VENTURE_ID}`]) })
    )

    expectErrorBody(result, 403, 'SCOPE_DENIED')
  })
})

describe('POST /ventures', () => {
  test('creates a venture with a scoped token and publishes venture.created', async () => {
    // Arrange
    const { handler, eventBridge } = setup()

    // Act
    const result = await handler(
      makeEvent({
        routeKey: 'POST /ventures',
        token: token(['venture:create']),
        body: { manifest: validManifestInput() }
      })
    )

    // Assert: 201 with the full record
    expect(result.statusCode).toBe(201)
    const body = parseBody(result)
    const venture = body['venture'] as Record<string, unknown>
    expect(venture['ventureId']).toBe(VENTURE_ID)
    expect(venture['ownerId']).toBe('agent-orchestrator-1')
    expect(venture['status']).toBe('active')
    expect(venture['version']).toBe(1)
    expect(venture['createdAt']).toBe(NOW.toISOString())
    expect((venture['manifest'] as Record<string, unknown>)['ventureId']).toBe(VENTURE_ID)
    expect(body['warnings']).toBeUndefined()

    // Assert: the event is on the bus with a schema-valid envelope
    const envelopes = (eventBridge as FakeEventBridgeClient).envelopes
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].type).toBe('venture.created')
    expect(envelopes[0].ventureId).toBe(VENTURE_ID)
    expect(envelopes[0].source).toBe('registry')
    expect((envelopes[0].payload as Record<string, unknown>)['version']).toBe(1)
  })

  test('generates ids matching the venture id pattern by default', async () => {
    const { handler } = setup({ deps: { generateVentureId: undefined } })

    const result = await handler(
      makeEvent({
        routeKey: 'POST /ventures',
        token: token(['venture:create']),
        body: { manifest: validManifestInput() }
      })
    )

    expect(result.statusCode).toBe(201)
    const venture = parseBody(result)['venture'] as Record<string, unknown>
    expect(venture['ventureId']).toMatch(/^venture-[a-z0-9][a-z0-9-]{1,61}$/)
  })

  test('rejects a caller-supplied ventureId', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({
        routeKey: 'POST /ventures',
        token: token(['venture:create']),
        body: { manifest: validManifest('venture-attacker-chosen') }
      })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('returns 400 INVALID_MANIFEST with Ajv paths for a schema-invalid manifest', async () => {
    // Arrange: missing budgets, bad db.provider
    const { handler, eventBridge } = setup()
    const invalid = validManifestInput({ db: { ref: 'db-1', provider: 'oracle' } })
    delete (invalid as Record<string, unknown>)['budgets']

    // Act
    const result = await handler(
      makeEvent({ routeKey: 'POST /ventures', token: token(['venture:create']), body: { manifest: invalid } })
    )

    // Assert: machine-readable details carry the failing paths
    const error = expectErrorBody(result, 400, 'INVALID_MANIFEST')
    const details = error['details'] as readonly Record<string, unknown>[]
    expect(details.length).toBeGreaterThan(0)
    const paths = details.map((detail) => detail['path'])
    expect(paths).toContain('/db/provider')
    expect(paths).toContain('/')
    expect((eventBridge as FakeEventBridgeClient).envelopes).toHaveLength(0)
  })

  test('rejects a non-JSON body', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({ routeKey: 'POST /ventures', token: token(['venture:create']), body: '{not json' })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('returns 201 with a warnings entry when the event publish fails', async () => {
    // Arrange: mutation succeeds, bus is down
    const { handler, dynamo } = setup({ eventBridge: new FailingEventBridgeClient() })

    // Act
    const result = await handler(
      makeEvent({
        routeKey: 'POST /ventures',
        token: token(['venture:create']),
        body: { manifest: validManifestInput() }
      })
    )

    // Assert: mutation committed, warning surfaced, nothing silently dropped
    expect(result.statusCode).toBe(201)
    const body = parseBody(result)
    const warnings = body['warnings'] as readonly Record<string, unknown>[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]['code']).toBe('EVENT_NOT_PUBLISHED')
    expect(warnings[0]['message']).toContain('venture.created')
    expect(dynamo.items.has(VENTURE_ID)).toBe(true)
  })
})

describe('GET /ventures/{ventureId}', () => {
  test('returns the venture for a token scoped to it', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token([`venture:read:${VENTURE_ID}`]),
        pathParameters: { ventureId: VENTURE_ID }
      })
    )

    expect(result.statusCode).toBe(200)
    const venture = parseBody(result)['venture'] as Record<string, unknown>
    expect(venture['ventureId']).toBe(VENTURE_ID)
  })

  test('a resource-less venture:read grant covers any venture', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read']),
        pathParameters: { ventureId: VENTURE_ID }
      })
    )

    expect(result.statusCode).toBe(200)
  })

  test('returns 404 for an unknown venture', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read']),
        pathParameters: { ventureId: 'venture-missing' }
      })
    )

    expectErrorBody(result, 404, 'VENTURE_NOT_FOUND')
  })

  test('returns 400 for a malformed venture id', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read']),
        pathParameters: { ventureId: 'Not-A-Venture!' }
      })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })
})

describe('GET /ventures', () => {
  function seedOwnerVentures(dynamo: FakeVenturesDynamoClient, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const ventureId = `venture-list-${index}`
      dynamo.seed(
        seededRecord({
          ventureId,
          manifest: validManifest(ventureId) as unknown as VentureRecord['manifest'],
          createdAt: `2026-07-2${index}T00:00:00.000Z`
        })
      )
    }
  }

  test('lists the caller-owned ventures newest first', async () => {
    const { handler, dynamo } = setup()
    seedOwnerVentures(dynamo, 3)

    const result = await handler(makeEvent({ routeKey: 'GET /ventures', token: token(['venture:read']) }))

    expect(result.statusCode).toBe(200)
    const body = parseBody(result)
    const ventures = body['ventures'] as readonly Record<string, unknown>[]
    expect(ventures.map((venture) => venture['ventureId'])).toEqual([
      'venture-list-2',
      'venture-list-1',
      'venture-list-0'
    ])
    expect(body['nextCursor']).toBeUndefined()
  })

  test('paginates with an opaque cursor', async () => {
    // Arrange
    const { handler, dynamo } = setup()
    seedOwnerVentures(dynamo, 3)

    // Act: first page of 2
    const firstPage = await handler(
      makeEvent({ routeKey: 'GET /ventures', token: token(['venture:read']), queryStringParameters: { limit: '2' } })
    )

    // Assert
    const firstBody = parseBody(firstPage)
    expect((firstBody['ventures'] as unknown[]).length).toBe(2)
    const cursor = firstBody['nextCursor'] as string
    expect(typeof cursor).toBe('string')

    // Act: second page
    const secondPage = await handler(
      makeEvent({
        routeKey: 'GET /ventures',
        token: token(['venture:read']),
        queryStringParameters: { limit: '2', cursor }
      })
    )

    // Assert
    const secondBody = parseBody(secondPage)
    const secondVentures = secondBody['ventures'] as readonly Record<string, unknown>[]
    expect(secondVentures.map((venture) => venture['ventureId'])).toEqual(['venture-list-0'])
    expect(secondBody['nextCursor']).toBeUndefined()
  })

  test('rejects an invalid cursor', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures',
        token: token(['venture:read']),
        queryStringParameters: { cursor: '!!!not-a-cursor!!!' }
      })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('rejects an out-of-range limit', async () => {
    const { handler } = setup()

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures',
        token: token(['venture:read']),
        queryStringParameters: { limit: '9999' }
      })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('lists another owner via the ownerId query parameter', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord({ ownerId: 'agent-other' }))

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures',
        token: token(['venture:read']),
        queryStringParameters: { ownerId: 'agent-other' }
      })
    )

    expect(result.statusCode).toBe(200)
    const ventures = parseBody(result)['ventures'] as readonly Record<string, unknown>[]
    expect(ventures).toHaveLength(1)
    expect(ventures[0]['ownerId']).toBe('agent-other')
  })
})

describe('PUT /ventures/{ventureId}/manifest', () => {
  const updatedManifest = () => validManifest(VENTURE_ID, { name: 'Renamed Venture' })

  function putEvent(body: unknown, scopes: readonly string[] = [`venture:write:${VENTURE_ID}`]) {
    return makeEvent({
      routeKey: 'PUT /ventures/{ventureId}/manifest',
      token: token(scopes),
      pathParameters: { ventureId: VENTURE_ID },
      body
    })
  }

  test('replaces the manifest at the expected version and publishes venture.manifest_updated', async () => {
    // Arrange
    const { handler, dynamo, eventBridge } = setup()
    dynamo.seed(seededRecord())

    // Act
    const result = await handler(putEvent({ manifest: updatedManifest(), expectedVersion: 1 }))

    // Assert
    expect(result.statusCode).toBe(200)
    const venture = parseBody(result)['venture'] as Record<string, unknown>
    expect(venture['version']).toBe(2)
    expect((venture['manifest'] as Record<string, unknown>)['name']).toBe('Renamed Venture')
    expect(venture['updatedAt']).toBe(NOW.toISOString())

    const envelopes = (eventBridge as FakeEventBridgeClient).envelopes
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].type).toBe('venture.manifest_updated')
    expect((envelopes[0].payload as Record<string, unknown>)['version']).toBe(2)
  })

  test('returns 409 VERSION_CONFLICT on a stale expectedVersion', async () => {
    const { handler, dynamo, eventBridge } = setup()
    dynamo.seed(seededRecord({ version: 3 }))

    const result = await handler(putEvent({ manifest: updatedManifest(), expectedVersion: 1 }))

    const error = expectErrorBody(result, 409, 'VERSION_CONFLICT')
    expect(error['message']).toContain('version 3')
    expect((eventBridge as FakeEventBridgeClient).envelopes).toHaveLength(0)
  })

  test('returns 409 VERSION_CONFLICT when the write races a concurrent mutation', async () => {
    // Arrange: read passes (version 1), but the conditional write finds version 2
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())
    const originalSend = dynamo.send.bind(dynamo)
    let getCount = 0
    jest.spyOn(dynamo, 'send').mockImplementation((command) => {
      const isGet = command.constructor.name === 'GetCommand'
      if (isGet) {
        getCount += 1
      }
      const result = originalSend(command)
      if (isGet && getCount === 1) {
        // Simulate a concurrent bump after the handler's read.
        return result.then((output) => {
          dynamo.seed(seededRecord({ version: 2 }))
          return output
        })
      }
      return result
    })

    // Act
    const result = await handler(putEvent({ manifest: updatedManifest(), expectedVersion: 1 }))

    // Assert
    expectErrorBody(result, 409, 'VERSION_CONFLICT')
  })

  test('returns 409 VENTURE_DELETED for a soft-deleted venture', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord({ status: 'deleted' }))

    const result = await handler(putEvent({ manifest: updatedManifest(), expectedVersion: 1 }))

    expectErrorBody(result, 409, 'VENTURE_DELETED')
  })

  test('returns 400 when the manifest ventureId does not match the path', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(
      putEvent({ manifest: validManifest('venture-other'), expectedVersion: 1 })
    )

    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('returns 404 for an unknown venture', async () => {
    const { handler } = setup()

    const result = await handler(putEvent({ manifest: updatedManifest(), expectedVersion: 1 }))

    expectErrorBody(result, 404, 'VENTURE_NOT_FOUND')
  })

  test('requires the venture:write scope for this venture', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(
      putEvent({ manifest: updatedManifest(), expectedVersion: 1 }, ['venture:write:venture-other'])
    )

    expectErrorBody(result, 403, 'SCOPE_DENIED')
  })
})

describe('DELETE /ventures/{ventureId}', () => {
  function deleteEvent(scopes: readonly string[] = [`venture:delete:${VENTURE_ID}`]) {
    return makeEvent({
      routeKey: 'DELETE /ventures/{ventureId}',
      token: token(scopes),
      pathParameters: { ventureId: VENTURE_ID }
    })
  }

  test('soft-deletes and publishes venture.deleted', async () => {
    // Arrange
    const { handler, dynamo, eventBridge } = setup()
    dynamo.seed(seededRecord())

    // Act
    const result = await handler(deleteEvent())

    // Assert: status flip, version bump, record retained
    expect(result.statusCode).toBe(200)
    const venture = parseBody(result)['venture'] as Record<string, unknown>
    expect(venture['status']).toBe('deleted')
    expect(venture['version']).toBe(2)
    expect(dynamo.items.get(VENTURE_ID)?.['status']).toBe('deleted')

    const envelopes = (eventBridge as FakeEventBridgeClient).envelopes
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].type).toBe('venture.deleted')
  })

  test('is idempotent: deleting an already deleted venture emits no second event', async () => {
    const { handler, dynamo, eventBridge } = setup()
    dynamo.seed(seededRecord({ status: 'deleted', version: 2 }))

    const result = await handler(deleteEvent())

    expect(result.statusCode).toBe(200)
    const venture = parseBody(result)['venture'] as Record<string, unknown>
    expect(venture['status']).toBe('deleted')
    expect(venture['version']).toBe(2)
    expect((eventBridge as FakeEventBridgeClient).envelopes).toHaveLength(0)
  })

  test('returns 404 for an unknown venture', async () => {
    const { handler } = setup()

    const result = await handler(deleteEvent())

    expectErrorBody(result, 404, 'VENTURE_NOT_FOUND')
  })

  test('requires the venture:delete scope', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed(seededRecord())

    const result = await handler(deleteEvent([`venture:write:${VENTURE_ID}`, `venture:read:${VENTURE_ID}`]))

    expectErrorBody(result, 403, 'SCOPE_DENIED')
  })
})

describe('registry — routing and hardening', () => {
  test('returns 404 ROUTE_NOT_FOUND for an unknown route key', async () => {
    const { handler } = setup()

    const result = await handler(makeEvent({ routeKey: 'PATCH /ventures', token: token(['venture:read']) }))

    expectErrorBody(result, 404, 'ROUTE_NOT_FOUND')
  })

  test('maps unexpected repository failures to a 500 without leaking internals', async () => {
    const { handler, dynamo } = setup()
    jest.spyOn(dynamo, 'send').mockRejectedValue(new Error('socket hang up: 10.0.0.7'))

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read']),
        pathParameters: { ventureId: VENTURE_ID }
      })
    )

    const error = expectErrorBody(result, 500, 'INTERNAL_ERROR')
    expect(error['message']).not.toContain('10.0.0.7')
  })

  test('fails closed on a corrupt stored record', async () => {
    const { handler, dynamo } = setup()
    dynamo.seed({ ventureId: VENTURE_ID, ownerId: 'agent-orchestrator-1', status: 'limbo', version: 0 })

    const result = await handler(
      makeEvent({
        routeKey: 'GET /ventures/{ventureId}',
        token: token(['venture:read']),
        pathParameters: { ventureId: VENTURE_ID }
      })
    )

    expectErrorBody(result, 500, 'INTERNAL_ERROR')
  })
})
