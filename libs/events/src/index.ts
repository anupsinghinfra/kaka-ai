/**
 * @platform/events — publisher for the platform event bus.
 *
 * Every event is validated against `contracts/events/envelope.schema.json`
 * before it is sent (EXECUTION.md §3 M0 item 3).
 */

export { EventPublishError, EventValidationError, type EventPublishFailure } from './errors'
export { EVENTBRIDGE_MAX_BATCH_ENTRIES, createPublisher } from './publisher'
export type {
  CreatePublisherOptions,
  EventBridgePutEventsClient,
  EventInput,
  EventPublisher
} from './types'
export { assertValidEnvelope } from './validation'
