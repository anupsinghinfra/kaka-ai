import type { PutEventsCommand, PutEventsCommandOutput } from '@aws-sdk/client-eventbridge'

/**
 * Caller-provided part of an event. The publisher fills the rest of the
 * envelope (`id`, `timestamp`, `source`) — see
 * `contracts/events/envelope.schema.json`.
 */
export interface EventInput<TPayload extends object = Record<string, unknown>> {
  /** Dot-delimited event type, e.g. `venture.created`. */
  readonly type: string
  /** Venture the event belongs to; `platform` for platform-level events. */
  readonly ventureId: string
  /** Event-type-specific payload. */
  readonly payload: TPayload
}

/**
 * Minimal EventBridge client surface the publisher needs. The real
 * `EventBridgeClient` satisfies this structurally; tests inject a mock.
 */
export interface EventBridgePutEventsClient {
  send(command: PutEventsCommand): Promise<PutEventsCommandOutput>
}

export interface CreatePublisherOptions {
  /** Name (or ARN) of the platform event bus, e.g. from SSM `/platform/events/bus-name`. */
  readonly busName: string
  /** Emitting component recorded in every envelope, e.g. `registry`. */
  readonly source: string
  /** Injectable client; defaults to a real `EventBridgeClient`. */
  readonly client?: EventBridgePutEventsClient
}

export interface EventPublisher {
  /** Validates and publishes a single event. Throws `EventValidationError` before sending anything invalid. */
  publish(event: EventInput): Promise<void>
  /**
   * Validates ALL events, then publishes them in EventBridge-sized chunks
   * (10 entries per PutEvents call). If any event is invalid, nothing is sent.
   */
  publishBatch(events: readonly EventInput[]): Promise<void>
}
