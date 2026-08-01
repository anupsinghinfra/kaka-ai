/**
 * POST /api/ideas/[name]/build — build v1 and stream NDJSON progress
 * events: {stage: ...}, then {stage: live, url} once the app is served,
 * then {stage: done, result} or {stage: error, error}.
 *
 * Agent mode (default): the idea's Builder agent on OnCell does the build
 * inside its own agent.llm loop; this route deploys it, snapshots the
 * cell, fires the "build" task, and relays the agent's progress from the
 * cell's kv. Local mode (KAKA_BUILDER_MODE=local): the original in-process
 * Anthropic flow, kept as an explicit escape hatch.
 */

import { jsonError, ndjsonResponse } from '@/lib/api'
import { runBuilderAgentPass } from '@/lib/builder-agent/orchestrate'
import { builderMode } from '@/lib/builder-agent/mode'
import { runBuild, type BuildEvent } from '@/lib/builder/run'
import { restartAppService } from '@/lib/builder/service'
import { getOnCell, isBuilderConfigured } from '@/lib/oncell'
import { getIdea, type Idea } from '@/lib/registry'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

/** The pre-agent local build flow, unchanged (KAKA_BUILDER_MODE=local). */
function localBuildResponse(idea: Idea, ideaText: string): Response {
  return ndjsonResponse(async (emit) => {
    const result = await runBuild(idea, ideaText, (event: BuildEvent) => emit(event))
    // The payoff: (re)start the app service so the idea has a live URL.
    emit({ stage: 'starting' })
    const service = await restartAppService(getOnCell(), idea)
    if (service.ok) {
      emit({ stage: 'live', url: service.liveUrl })
      emit({ stage: 'done', result: { ...result, liveUrl: service.liveUrl } })
      return
    }
    emit({ stage: 'done', result: { ...result, serviceError: service.serviceError } })
  })
}

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
      'there is no idea text to build from',
      400,
      'Add the idea text first — it is what gets built.'
    )
  }
  if (!isBuilderConfigured()) {
    return builderMode() === 'local'
      ? jsonError(
          'ANTHROPIC_KEY_MISSING',
          'building locally needs an Anthropic API key',
          503,
          'Add ANTHROPIC_API_KEY to the repo-root .env.'
        )
      : jsonError(
          'ONCELL_KEY_MISSING',
          'building needs an OnCell API key',
          503,
          'Add ONCELL_API_KEY to the repo-root .env.'
        )
  }

  if (builderMode() === 'local') {
    return localBuildResponse(idea, ideaText)
  }
  return ndjsonResponse((emit) => runBuilderAgentPass(idea, ideaText, 'build', emit))
}
