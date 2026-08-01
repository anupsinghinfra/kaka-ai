/**
 * POST /api/ventures/[name]/build — run the Builder and stream NDJSON
 * progress events: {stage: generating|writing|verifying}, then
 * {stage: done, result} or {stage: error, error}.
 */

import { jsonError, type ApiErrorBody } from '@/lib/api'
import { BuilderResponseError, runBuild, type BuildEvent } from '@/lib/builder/run'
import { isBuilderConfigured } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'
import { OnCellApiError } from '@platform/oncell'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

function toStreamError(error: unknown): ApiErrorBody['error'] {
  if (error instanceof BuilderResponseError) {
    return {
      code: 'BUILDER_INVALID_OUTPUT',
      message: error.message,
      remediation: 'Try building again, or refine the idea to something smaller.'
    }
  }
  if (error instanceof OnCellApiError) {
    return {
      code: error.code ?? 'ONCELL_API_ERROR',
      message: error.message,
      ...(error.remediation !== undefined ? { remediation: error.remediation } : {})
    }
  }
  return {
    code: 'BUILD_FAILED',
    message: error instanceof Error ? error.message : String(error)
  }
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const venture = getVenture(name)
  if (venture === undefined) {
    return jsonError('VENTURE_NOT_FOUND', `venture "${name}" not found`, 404)
  }
  const idea = venture.idea
  if (idea === undefined || idea.trim().length === 0) {
    return jsonError(
      'IDEA_REQUIRED',
      'this venture has no idea to build from',
      400,
      'Recreate the venture with an idea, or add one to the registry.'
    )
  }
  if (!isBuilderConfigured()) {
    return jsonError(
      'ANTHROPIC_KEY_MISSING',
      'the Builder needs an Anthropic API key',
      503,
      'Add ANTHROPIC_API_KEY to the repo-root .env. Venture lifecycle works without it.'
    )
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: object): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      try {
        const result = await runBuild(venture, idea, (event: BuildEvent) => emit(event))
        emit({ stage: 'done', result })
      } catch (error: unknown) {
        emit({ stage: 'error', error: toStreamError(error) })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}
