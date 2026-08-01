/**
 * POST /api/ideas/[name]/improve — run one auto-improve iteration and
 * stream NDJSON progress events: {stage: reading|snapshotting|generating|
 * writing|verifying}, then {stage: done, result} or {stage: error, error}.
 */

import { jsonError, ndjsonResponse } from '@/lib/api'
import { NothingToImproveError, runImprove, type ImproveEvent } from '@/lib/builder/improve'
import { isBuilderConfigured } from '@/lib/oncell'
import { currentVersion, getIdea } from '@/lib/registry'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const idea = getIdea(name)
  if (idea === undefined) {
    return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
  }
  const ideaText = idea.idea
  if (ideaText === undefined || ideaText.trim().length === 0) {
    return jsonError(
      'IDEA_REQUIRED',
      'there is no idea text to improve against',
      400,
      'Add the idea text first — improvements are chosen to serve it.'
    )
  }
  if (currentVersion(idea) === 0) {
    return jsonError(
      'NOT_BUILT_YET',
      `"${name}" has no v1 yet — build it first, then it can start improving itself`,
      409
    )
  }
  if (!isBuilderConfigured()) {
    return jsonError(
      'ANTHROPIC_KEY_MISSING',
      'improving needs an Anthropic API key',
      503,
      'Add ANTHROPIC_API_KEY to the repo-root .env.'
    )
  }

  return ndjsonResponse(async (emit) => {
    try {
      const result = await runImprove(idea, ideaText, (event: ImproveEvent) => emit(event))
      emit({ stage: 'done', result })
    } catch (error: unknown) {
      if (error instanceof NothingToImproveError) {
        emit({
          stage: 'error',
          error: { code: 'NOT_BUILT_YET', message: error.message }
        })
        return
      }
      throw error
    }
  })
}
