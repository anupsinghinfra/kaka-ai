/**
 * POST /api/ideas/[name]/improve — one improvement iteration, streamed as
 * NDJSON stage events, then {stage: done, result} or {stage: error, error}.
 *
 * Agent mode (default): the idea's Builder agent on OnCell runs the
 * improvement (its "improve" task/skill); this route deploys it, snapshots
 * the cell as the rollback point, fires the task, and relays progress from
 * the cell's kv. Local mode (KAKA_BUILDER_MODE=local): the original
 * in-process Anthropic flow, kept as an explicit escape hatch.
 */

import { jsonError, ndjsonResponse, readJsonBody } from '@/lib/api'
import { builderMode } from '@/lib/builder-agent/mode'
import { runBuilderAgentPass } from '@/lib/builder-agent/orchestrate'
import { NothingToImproveError, runImprove, type ImproveEvent } from '@/lib/builder/improve'
import { restartAppService } from '@/lib/builder/service'
import { getOnCell, isBuilderConfigured } from '@/lib/oncell'
import { currentVersion, getIdea, type Idea } from '@/lib/registry'
import { IMPROVE_DIRECTION_MAX_LENGTH, improveBodySchema } from '@/lib/validation'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

/** The pre-agent local improve flow, unchanged (KAKA_BUILDER_MODE=local). */
function localImproveResponse(idea: Idea, ideaText: string): Response {
  return ndjsonResponse(async (emit) => {
    try {
      const result = await runImprove(idea, ideaText, (event: ImproveEvent) => emit(event))
      // The payoff: (re)start the app service so the update is live.
      emit({ stage: 'starting' })
      const service = await restartAppService(getOnCell(), idea)
      if (service.ok) {
        emit({ stage: 'live', url: service.liveUrl })
        emit({ stage: 'done', result: { ...result, liveUrl: service.liveUrl } })
        return
      }
      emit({ stage: 'done', result: { ...result, serviceError: service.serviceError } })
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

/**
 * Optional founder direction from the request body. Returns an error
 * Response when a direction is present but over the limit; undefined
 * direction when there is no usable body (the endpoint's historical shape).
 */
async function readDirection(
  request: Request
): Promise<{ direction?: string } | { errorResponse: Response }> {
  const body = await readJsonBody(request)
  if (body === undefined || body === null) {
    return {}
  }
  const parsed = improveBodySchema.safeParse(body)
  if (!parsed.success) {
    return {
      errorResponse: jsonError(
        'DIRECTION_TOO_LONG',
        `direction must be at most ${IMPROVE_DIRECTION_MAX_LENGTH} characters`,
        400,
        'Shorten the direction — one or two sentences is plenty.'
      )
    }
  }
  const direction = parsed.data.direction
  return direction !== undefined && direction.length > 0 ? { direction } : {}
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const idea = getIdea(name)
  if (idea === undefined) {
    return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
  }
  const directed = await readDirection(request)
  if ('errorResponse' in directed) {
    return directed.errorResponse
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
    return builderMode() === 'local'
      ? jsonError(
          'ANTHROPIC_KEY_MISSING',
          'improving locally needs an Anthropic API key',
          503,
          'Add ANTHROPIC_API_KEY to the repo-root .env.'
        )
      : jsonError(
          'ONCELL_KEY_MISSING',
          'improving needs an OnCell API key',
          503,
          'Add ONCELL_API_KEY to the repo-root .env.'
        )
  }

  if (builderMode() === 'local') {
    return localImproveResponse(idea, ideaText)
  }
  return ndjsonResponse((emit) =>
    runBuilderAgentPass(idea, ideaText, 'improve', emit, {
      ...(directed.direction !== undefined ? { direction: directed.direction } : {})
    })
  )
}
