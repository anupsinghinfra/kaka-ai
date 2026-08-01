/**
 * POST /api/ideas/[name]/build — build v1 and stream NDJSON progress
 * events: {stage: generating|writing|verifying}, then {stage: done,
 * result} or {stage: error, error}.
 */

import { jsonError, ndjsonResponse } from '@/lib/api'
import { runBuild, type BuildEvent } from '@/lib/builder/run'
import { isBuilderConfigured } from '@/lib/oncell'
import { getIdea } from '@/lib/registry'

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
      'there is no idea text to build from',
      400,
      'Add the idea text first — it is what gets built.'
    )
  }
  if (!isBuilderConfigured()) {
    return jsonError(
      'ANTHROPIC_KEY_MISSING',
      'building needs an Anthropic API key',
      503,
      'Add ANTHROPIC_API_KEY to the repo-root .env.'
    )
  }

  return ndjsonResponse(async (emit) => {
    const result = await runBuild(idea, ideaText, (event: BuildEvent) => emit(event))
    emit({ stage: 'done', result })
  })
}
