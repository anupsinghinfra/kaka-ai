/**
 * `GET /ventures` — list ventures by owner, newest first, paginated.
 * Scope: resource-less `venture:read` (listing spans resources, so a
 * venture-scoped read grant does not cover it — strictest reading of the
 * scope grammar: a grant with a resource never covers a resource-less
 * requirement).
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { requireScope } from '@platform/authorizer'
import { authenticate } from '../auth'
import { jsonResponse } from '../http'
import { encodeCursor, parseListVenturesQuery } from '../request'
import type { HandlerDependencies, VentureListResponseBody } from '../types'

export async function handleListVentures(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies
): Promise<APIGatewayProxyStructuredResultV2> {
  const verified = await authenticate(event, deps.getVerificationKey, deps.now)
  requireScope(verified, 'venture:read')

  const query = parseListVenturesQuery(event.queryStringParameters)
  const ownerId = query.ownerId ?? verified.sub

  const page = await deps.ventures.listByOwner(ownerId, query.limit, query.exclusiveStartKey)

  const body: VentureListResponseBody = {
    ventures: page.ventures,
    ...(page.lastEvaluatedKey !== undefined ? { nextCursor: encodeCursor(page.lastEvaluatedKey) } : {})
  }

  return jsonResponse(200, body)
}
