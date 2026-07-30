import { PutEventsCommand, type PutEventsCommandOutput } from '@aws-sdk/client-eventbridge'
import type { EventEnvelope } from '@platform/contracts'
import {
  EVENTBRIDGE_MAX_BATCH_ENTRIES,
  EventPublishError,
  EventValidationError,
  assertValidEnvelope,
  createPublisher,
  type EventBridgePutEventsClient,
  type EventInput
} from '../src/index'

const BUS_NAME = 'platform-bus'
const SOURCE = 'registry'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const VALID_EVENT: EventInput = {
  type: 'venture.created',
  ventureId: 'venture-42',
  payload: { name: 'Example Venture' }
}

interface MockClient {
  readonly client: EventBridgePutEventsClient
  readonly send: jest.Mock<Promise<PutEventsCommandOutput>, [PutEventsCommand]>
}

function createMockClient(output?: Partial<PutEventsCommandOutput>): MockClient {
  const response: PutEventsCommandOutput = {
    $metadata: {},
    FailedEntryCount: 0,
    Entries: [],
    ...output
  }
  const send = jest.fn<Promise<PutEventsCommandOutput>, [PutEventsCommand]>()
  send.mockResolvedValue(response)
  return { client: { send }, send }
}

function sentEntries(send: MockClient['send'], callIndex: number): NonNullable<PutEventsCommand['input']['Entries']> {
  const command = send.mock.calls[callIndex][0]
  return command.input.Entries ?? []
}

describe('createPublisher', () => {
  test('throws when busName is empty', () => {
    // Arrange
    const { client } = createMockClient()

    // Act + Assert
    expect(() => createPublisher({ busName: '', source: SOURCE, client })).toThrow(/busName/)
  })

  test('throws when source is empty', () => {
    const { client } = createMockClient()

    expect(() => createPublisher({ busName: BUS_NAME, source: '', client })).toThrow(/source/)
  })

  test('defaults to a real EventBridge client when none is injected', () => {
    // Act: constructing the client is local — no AWS call is made.
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE })

    // Assert
    expect(typeof publisher.publish).toBe('function')
    expect(typeof publisher.publishBatch).toBe('function')
  })
})

describe('assertValidEnvelope', () => {
  test('reports root-level errors for unknown envelope properties', () => {
    // Arrange: additionalProperties violations surface at the envelope root.
    const envelopeWithExtraField = {
      id: '4b1c8f0a-0d5e-4c3b-9a2f-7e6d5c4b3a21',
      type: 'venture.created',
      ventureId: 'venture-42',
      timestamp: '2026-07-28T12:00:00Z',
      source: SOURCE,
      payload: {},
      extra: 'not-allowed'
    } as unknown as EventEnvelope

    // Act + Assert
    expect(() => assertValidEnvelope(envelopeWithExtraField)).toThrow(EventValidationError)
  })
})

describe('publish', () => {
  test('sends a valid event as a schema-valid envelope on the configured bus', async () => {
    // Arrange
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    // Act
    await publisher.publish(VALID_EVENT)

    // Assert
    expect(send).toHaveBeenCalledTimes(1)
    const entries = sentEntries(send, 0)
    expect(entries).toHaveLength(1)

    const entry = entries[0]
    expect(entry.EventBusName).toBe(BUS_NAME)
    expect(entry.Source).toBe(SOURCE)
    expect(entry.DetailType).toBe(VALID_EVENT.type)

    const envelope = JSON.parse(entry.Detail ?? '{}') as EventEnvelope
    expect(envelope.id).toMatch(UUID_PATTERN)
    expect(envelope.timestamp).toMatch(ISO_TIMESTAMP_PATTERN)
    expect(envelope.type).toBe(VALID_EVENT.type)
    expect(envelope.ventureId).toBe(VALID_EVENT.ventureId)
    expect(envelope.source).toBe(SOURCE)
    expect(envelope.payload).toEqual(VALID_EVENT.payload)
  })

  test('assigns a unique id to every published event', async () => {
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    await publisher.publish(VALID_EVENT)
    await publisher.publish(VALID_EVENT)

    const first = JSON.parse(sentEntries(send, 0)[0].Detail ?? '{}') as EventEnvelope
    const second = JSON.parse(sentEntries(send, 1)[0].Detail ?? '{}') as EventEnvelope
    expect(first.id).not.toBe(second.id)
  })

  test('throws EventValidationError for an invalid event type and never calls the client', async () => {
    // Arrange
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })
    const invalidEvent: EventInput = { ...VALID_EVENT, type: 'NotDotDelimited' }

    // Act
    const attempt = publisher.publish(invalidEvent)

    // Assert
    await expect(attempt).rejects.toThrow(EventValidationError)
    expect(send).not.toHaveBeenCalled()
  })

  test('attaches the Ajv errors to the EventValidationError', async () => {
    const { client } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })
    const invalidEvent: EventInput = { ...VALID_EVENT, ventureId: '' }

    let caught: unknown
    try {
      await publisher.publish(invalidEvent)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EventValidationError)
    const validationError = caught as EventValidationError
    expect(validationError.errors.length).toBeGreaterThan(0)
    expect(validationError.errors[0].instancePath).toBe('/ventureId')
  })

  test('treats a response without FailedEntryCount as success', async () => {
    // Arrange
    const { client, send } = createMockClient({ FailedEntryCount: undefined, Entries: undefined })
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    // Act
    await publisher.publish(VALID_EVENT)

    // Assert
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('reports no failure details when EventBridge omits result entries', async () => {
    // Arrange
    const { client } = createMockClient({ FailedEntryCount: 1, Entries: undefined })
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    // Act
    const attempt = publisher.publish(VALID_EVENT)

    // Assert
    await expect(attempt).rejects.toThrow(EventPublishError)
    await attempt.catch((error: unknown) => {
      expect((error as EventPublishError).failures).toEqual([])
    })
  })

  test('throws EventPublishError when EventBridge reports failed entries', async () => {
    // Arrange
    const { client } = createMockClient({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' }]
    })
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    // Act
    const attempt = publisher.publish(VALID_EVENT)

    // Assert
    await expect(attempt).rejects.toThrow(EventPublishError)
    await attempt.catch((error: unknown) => {
      const publishError = error as EventPublishError
      expect(publishError.failedEntryCount).toBe(1)
      expect(publishError.failures).toEqual([
        { eventId: undefined, errorCode: 'ThrottlingException', errorMessage: 'Rate exceeded' }
      ])
    })
  })
})

describe('publishBatch', () => {
  test('does nothing for an empty batch', async () => {
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })

    await publisher.publishBatch([])

    expect(send).not.toHaveBeenCalled()
  })

  test('chunks batches at the EventBridge 10-entry limit', async () => {
    // Arrange
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })
    const events: readonly EventInput[] = Array.from({ length: 25 }, (_, index) => ({
      ...VALID_EVENT,
      payload: { index }
    }))

    // Act
    await publisher.publishBatch(events)

    // Assert
    expect(EVENTBRIDGE_MAX_BATCH_ENTRIES).toBe(10)
    expect(send).toHaveBeenCalledTimes(3)
    expect(sentEntries(send, 0)).toHaveLength(10)
    expect(sentEntries(send, 1)).toHaveLength(10)
    expect(sentEntries(send, 2)).toHaveLength(5)
  })

  test('sends exactly one call for a batch at the limit boundary', async () => {
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })
    const events: readonly EventInput[] = Array.from({ length: 10 }, () => VALID_EVENT)

    await publisher.publishBatch(events)

    expect(send).toHaveBeenCalledTimes(1)
    expect(sentEntries(send, 0)).toHaveLength(10)
  })

  test('rejects the whole batch and sends nothing when any event is invalid', async () => {
    // Arrange
    const { client, send } = createMockClient()
    const publisher = createPublisher({ busName: BUS_NAME, source: SOURCE, client })
    const events: readonly EventInput[] = [
      VALID_EVENT,
      { ...VALID_EVENT, type: 'Invalid Type!' },
      VALID_EVENT
    ]

    // Act
    const attempt = publisher.publishBatch(events)

    // Assert
    await expect(attempt).rejects.toThrow(EventValidationError)
    expect(send).not.toHaveBeenCalled()
  })
})
