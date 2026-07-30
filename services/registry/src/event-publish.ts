/**
 * Post-mutation event publishing.
 *
 * Consistency decision (documented tradeoff): the DynamoDB mutation is the
 * source of truth; the bus event is at-least-once *eventually*, not
 * atomically. If `PutEvents` fails after the write commits, we do NOT fail or
 * roll back the mutation — we log at error level and surface a `warnings`
 * entry in the response so the caller (and operators) know the audit event is
 * missing. A reconciler (table stream/scan vs. bus archive) heals the gap
 * later. The alternative — failing the request — would leave the caller
 * believing a committed mutation did not happen, which is worse.
 */

import type { EventInput, EventPublisher } from '@platform/events'
import type { Logger } from './logging'
import type { ResponseWarning } from './types'

export const VENTURE_CREATED_EVENT = 'venture.created'
export const VENTURE_MANIFEST_UPDATED_EVENT = 'venture.manifest_updated'
export const VENTURE_DELETED_EVENT = 'venture.deleted'

/**
 * Publishes a mutation event; returns warnings instead of throwing.
 * An empty array means the event is on the bus.
 */
export async function publishMutationEvent(
  publisher: EventPublisher,
  event: EventInput,
  logger: Logger
): Promise<readonly ResponseWarning[]> {
  try {
    await publisher.publish(event)
    return []
  } catch (error: unknown) {
    logger.error(
      { err: error, eventType: event.type, ventureId: event.ventureId },
      'mutation committed but event publish failed; reconciler must emit the event'
    )

    return [
      {
        code: 'EVENT_NOT_PUBLISHED',
        message:
          `The mutation succeeded, but the "${event.type}" event could not be published to the platform bus. ` +
          'The registry record is authoritative; a reconciler will emit the missing event.'
      }
    ]
  }
}
