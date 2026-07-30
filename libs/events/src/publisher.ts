import { randomUUID } from 'node:crypto'
import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
  type PutEventsResultEntry
} from '@aws-sdk/client-eventbridge'
import type { EventEnvelope } from '@platform/contracts'
import { EventPublishError, type EventPublishFailure } from './errors'
import { logger } from './logger'
import type {
  CreatePublisherOptions,
  EventBridgePutEventsClient,
  EventInput,
  EventPublisher
} from './types'
import { assertValidEnvelope } from './validation'

/** Hard EventBridge limit on entries per PutEvents call. */
export const EVENTBRIDGE_MAX_BATCH_ENTRIES = 10

function buildEnvelope(event: EventInput, source: string): EventEnvelope {
  return {
    id: randomUUID(),
    type: event.type,
    ventureId: event.ventureId,
    timestamp: new Date().toISOString(),
    source,
    payload: event.payload
  }
}

function toPutEventsEntry(envelope: EventEnvelope, busName: string): PutEventsRequestEntry {
  return {
    EventBusName: busName,
    Source: envelope.source,
    DetailType: envelope.type,
    Detail: JSON.stringify(envelope),
    Time: new Date(envelope.timestamp)
  }
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: (readonly T[])[] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}

function extractFailures(entries: readonly PutEventsResultEntry[]): readonly EventPublishFailure[] {
  return entries
    .filter((entry) => entry.ErrorCode !== undefined)
    .map((entry) => ({
      eventId: entry.EventId,
      errorCode: entry.ErrorCode,
      errorMessage: entry.ErrorMessage
    }))
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`createPublisher: "${field}" must be a non-empty string`)
  }
}

/**
 * Creates a publisher for the platform event bus.
 *
 * Every event is validated against `contracts/events/envelope.schema.json`
 * before anything is sent; invalid events throw `EventValidationError` and
 * the EventBridge client is never called. The publisher fills `id` (UUID),
 * `timestamp` (ISO 8601 UTC), and `source`; callers provide `type`,
 * `ventureId`, and `payload`.
 */
export function createPublisher(options: CreatePublisherOptions): EventPublisher {
  const { busName, source } = options
  assertNonEmpty(busName, 'busName')
  assertNonEmpty(source, 'source')

  const client: EventBridgePutEventsClient = options.client ?? new EventBridgeClient({})

  async function sendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    const entries = envelopes.map((envelope) => toPutEventsEntry(envelope, busName))
    const response = await client.send(new PutEventsCommand({ Entries: [...entries] }))
    const failedEntryCount = response.FailedEntryCount ?? 0

    if (failedEntryCount > 0) {
      const failures = extractFailures(response.Entries ?? [])
      logger.error({ busName, failedEntryCount, failures }, 'EventBridge rejected event entries')
      throw new EventPublishError(
        `EventBridge rejected ${failedEntryCount} of ${entries.length} event entries`,
        failedEntryCount,
        failures
      )
    }

    logger.debug(
      { busName, count: envelopes.length, eventIds: envelopes.map((envelope) => envelope.id) },
      'published events to platform bus'
    )
  }

  async function publishBatch(events: readonly EventInput[]): Promise<void> {
    if (events.length === 0) {
      return
    }

    const envelopes = events.map((event) => buildEnvelope(event, source))

    // Validate everything BEFORE any network call: an invalid event anywhere
    // in the batch means nothing is sent.
    for (const envelope of envelopes) {
      assertValidEnvelope(envelope)
    }

    for (const batch of chunk(envelopes, EVENTBRIDGE_MAX_BATCH_ENTRIES)) {
      await sendBatch(batch)
    }
  }

  return {
    publish: (event: EventInput): Promise<void> => publishBatch([event]),
    publishBatch
  }
}
