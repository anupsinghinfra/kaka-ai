/**
 * POST /api/ideas/[name]/fork — fork the idea (code + files + state)
 * into a new idea with the given name.
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { forkIdea, IdeaConflictError, IdeaNotFoundError } from '@/lib/ideas'
import { forkIdeaSchema } from '@/lib/validation'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const body = await readJsonBody(request)
    const parsed = forkIdeaSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const idea = await forkIdea(name, parsed.data.name)
    return jsonOk({ idea }, 201)
  } catch (error: unknown) {
    if (error instanceof IdeaNotFoundError) {
      return jsonError('IDEA_NOT_FOUND', error.message, 404)
    }
    if (error instanceof IdeaConflictError) {
      return jsonError('IDEA_EXISTS', error.message, 409, 'Pick a different name for the fork.')
    }
    return toErrorResponse(error)
  }
}
