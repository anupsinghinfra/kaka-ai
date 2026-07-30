/**
 * `DELETE /ventures/{ventureId}` — soft delete (status flip, record kept).
 * Scope: `venture:delete:{ventureId}`. Idempotent: deleting an already
 * deleted venture returns the record again without emitting a second event.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { requireScope } from '@platform/authorizer'
import { authenticate } from '../auth'
import { ventureNotFound } from '../errors'
import { publishMutationEvent, VENTURE_DELETED_EVENT } from '../event-publish'
import { jsonResponse, ventureBody } from '../http'
import type { Logger } from '../logging'
import { requireVentureIdParam } from '../request'
import type { HandlerDependencies, VentureRecord } from '../types'

export async function handleDeleteVenture(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies,
  log: Logger
): Promise<APIGatewayProxyStructuredResultV2> {
  const verified = await authenticate(event, deps.getVerificationKey, deps.now)
  const ventureId = requireVentureIdParam(event.pathParameters)
  requireScope(verified, `venture:delete:${ventureId}`)

  const existing = await deps.ventures.findById(ventureId)

  if (existing === null) {
    throw ventureNotFound(ventureId)
  }

  if (existing.status === 'deleted') {
    // Idempotent no-op: the transition already happened and was announced.
    return jsonResponse(200, ventureBody(existing, []))
  }

  const next: VentureRecord = {
    ...existing,
    status: 'deleted',
    version: existing.version + 1,
    updatedAt: currentTimestamp(deps)
  }

  // Concurrent mutations surface as VERSION_CONFLICT via the conditional write.
  await deps.ventures.replace(next, existing.version)
  log.info({ ventureId, version: next.version, principal: verified.sub }, 'venture soft-deleted')

  const warnings = await publishMutationEvent(
    deps.publisher,
    {
      type: VENTURE_DELETED_EVENT,
      ventureId,
      payload: {
        ventureId,
        ownerId: next.ownerId,
        version: next.version
      }
    },
    log
  )

  return jsonResponse(200, ventureBody(next, warnings))
}

function currentTimestamp(deps: HandlerDependencies): string {
  return (deps.now ?? ((): Date => new Date()))().toISOString()
}
