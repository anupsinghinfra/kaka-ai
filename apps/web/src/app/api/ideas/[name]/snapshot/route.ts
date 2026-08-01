/**
 * POST /api/ideas/[name]/snapshot — snapshot the cell and record the key.
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { IdeaNotFoundError, snapshotIdea } from '@/lib/ideas'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const snapshot = await snapshotIdea(name)
    return jsonOk({ snapshot }, 201)
  } catch (error: unknown) {
    if (error instanceof IdeaNotFoundError) {
      return jsonError('IDEA_NOT_FOUND', error.message, 404)
    }
    return toErrorResponse(error)
  }
}
