/**
 * POST /api/ventures/[name]/fork — fork the venture (code + files + state)
 * into a new venture with the given name.
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { forkVentureSchema } from '@/lib/validation'
import { forkVenture, VentureConflictError, VentureNotFoundError } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const body = await readJsonBody(request)
    const parsed = forkVentureSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const venture = await forkVenture(name, parsed.data.name)
    return jsonOk({ venture }, 201)
  } catch (error: unknown) {
    if (error instanceof VentureNotFoundError) {
      return jsonError('VENTURE_NOT_FOUND', error.message, 404)
    }
    if (error instanceof VentureConflictError) {
      return jsonError('VENTURE_EXISTS', error.message, 409, 'Pick a different name for the fork.')
    }
    return toErrorResponse(error)
  }
}
