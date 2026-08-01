/**
 * GET  /api/ventures — registry ventures with live cell status.
 * POST /api/ventures — create a venture (cell + in-cell seed + registry).
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { listVentures } from '@/lib/registry'
import { createVentureSchema } from '@/lib/validation'
import { createVenture, VentureConflictError, withStatuses } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const ventures = await withStatuses(listVentures())
    return jsonOk({ ventures })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    const parsed = createVentureSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const idea = parsed.data.idea !== undefined && parsed.data.idea.length > 0 ? parsed.data.idea : undefined
    const venture = await createVenture(parsed.data.name, idea)
    return jsonOk({ venture }, 201)
  } catch (error: unknown) {
    if (error instanceof VentureConflictError) {
      return jsonError('VENTURE_EXISTS', error.message, 409, 'Pick a different venture name.')
    }
    return toErrorResponse(error)
  }
}
