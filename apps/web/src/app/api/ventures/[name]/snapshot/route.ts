/**
 * POST /api/ventures/[name]/snapshot — snapshot the cell and record the key.
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { snapshotVenture, VentureNotFoundError } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const snapshot = await snapshotVenture(name)
    return jsonOk({ snapshot }, 201)
  } catch (error: unknown) {
    if (error instanceof VentureNotFoundError) {
      return jsonError('VENTURE_NOT_FOUND', error.message, 404)
    }
    return toErrorResponse(error)
  }
}
