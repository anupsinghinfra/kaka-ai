/** Small HTTP helpers shared by every route. */

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import type { ResponseWarning, VentureRecord, VentureResponseBody } from './types'

export function jsonResponse(statusCode: number, body: object): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  }
}

/** Builds a venture response body, attaching `warnings` only when present. */
export function ventureBody(venture: VentureRecord, warnings: readonly ResponseWarning[]): VentureResponseBody {
  return {
    venture,
    ...(warnings.length > 0 ? { warnings } : {})
  }
}
