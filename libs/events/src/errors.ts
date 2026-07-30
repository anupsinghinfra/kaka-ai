import type { ErrorObject } from 'ajv'

/**
 * Thrown when an event fails validation against
 * `contracts/events/envelope.schema.json`. The event is never sent.
 */
export class EventValidationError extends Error {
  /** Ajv validation errors describing exactly which envelope fields failed. */
  public readonly errors: readonly ErrorObject[]

  constructor(message: string, errors: readonly ErrorObject[]) {
    super(message)
    this.name = 'EventValidationError'
    this.errors = errors
  }
}

/** A single entry EventBridge rejected within a PutEvents call. */
export interface EventPublishFailure {
  readonly eventId?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}

/**
 * Thrown when EventBridge accepts the PutEvents call but rejects one or more
 * entries (partial failure). Never swallowed — the caller must decide how to
 * retry.
 */
export class EventPublishError extends Error {
  public readonly failedEntryCount: number
  public readonly failures: readonly EventPublishFailure[]

  constructor(message: string, failedEntryCount: number, failures: readonly EventPublishFailure[]) {
    super(message)
    this.name = 'EventPublishError'
    this.failedEntryCount = failedEntryCount
    this.failures = failures
  }
}
