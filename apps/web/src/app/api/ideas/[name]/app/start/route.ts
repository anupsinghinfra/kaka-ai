/**
 * POST /api/ideas/[name]/app/start — (re)start the built app's service in
 * the cell and record the live preview URL on the idea. Used by the UI's
 * "Start app" retry after a post-build start failure.
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { restartAppService } from '@/lib/builder/service'
import { getOnCell } from '@/lib/oncell'
import { currentVersion, getIdea } from '@/lib/registry'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const idea = getIdea(name)
  if (idea === undefined) {
    return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
  }
  if (currentVersion(idea) === 0) {
    return jsonError(
      'NOT_BUILT_YET',
      `"${name}" has no v1 yet — build it first, then its app can be started`,
      409
    )
  }
  try {
    const service = await restartAppService(getOnCell(), idea)
    if (service.ok) {
      return jsonOk({ liveUrl: service.liveUrl })
    }
    return jsonError(
      'SERVICE_START_FAILED',
      service.serviceError,
      502,
      'Check the app under the hood (run "node src/server.js" in the console), or rebuild.'
    )
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}
