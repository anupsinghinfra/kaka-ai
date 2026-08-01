/**
 * GET  /api/ideas — registry ideas with live cell status.
 * POST /api/ideas — create an idea (cell + in-cell seed + registry).
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { createIdea, IdeaConflictError, withStatuses } from '@/lib/ideas'
import { listIdeas } from '@/lib/registry'
import { createIdeaSchema } from '@/lib/validation'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const ideas = await withStatuses(listIdeas())
    return jsonOk({ ideas })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request)
    const parsed = createIdeaSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const ideaText =
      parsed.data.idea !== undefined && parsed.data.idea.length > 0 ? parsed.data.idea : undefined
    const idea = await createIdea(parsed.data.name, ideaText)
    return jsonOk({ idea }, 201)
  } catch (error: unknown) {
    if (error instanceof IdeaConflictError) {
      return jsonError('IDEA_EXISTS', error.message, 409, 'Pick a different name.')
    }
    return toErrorResponse(error)
  }
}
