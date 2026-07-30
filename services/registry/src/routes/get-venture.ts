/**
 * `GET /ventures/{ventureId}` — read one venture record.
 * Scope: `venture:read:{ventureId}` (a resource-less `venture:read` grant
 * covers it). Soft-deleted ventures are returned with `status: "deleted"` —
 * auditability beats pretending they never existed.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { requireScope } from '@platform/authorizer'
import { authenticate } from '../auth'
import { ventureNotFound } from '../errors'
import { jsonResponse } from '../http'
import { requireVentureIdParam } from '../request'
import type { HandlerDependencies } from '../types'

export async function handleGetVenture(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies
): Promise<APIGatewayProxyStructuredResultV2> {
  const verified = await authenticate(event, deps.getVerificationKey, deps.now)
  const ventureId = requireVentureIdParam(event.pathParameters)
  requireScope(verified, `venture:read:${ventureId}`)

  const record = await deps.ventures.findById(ventureId)

  if (record === null) {
    throw ventureNotFound(ventureId)
  }

  return jsonResponse(200, { venture: record })
}
