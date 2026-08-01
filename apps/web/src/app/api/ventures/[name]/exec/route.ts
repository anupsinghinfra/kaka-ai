/**
 * POST /api/ventures/[name]/exec — run a command in the venture's cell.
 * Idempotency keys are generated automatically for safe retries.
 */

import { randomUUID } from 'node:crypto'
import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { getOnCell } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'
import { execSchema } from '@/lib/validation'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

const DEFAULT_EXEC_TIMEOUT_MS = 60_000

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const venture = getVenture(name)
    if (venture === undefined) {
      return jsonError('VENTURE_NOT_FOUND', `venture "${name}" not found`, 404)
    }
    const body = await readJsonBody(request)
    const parsed = execSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const result = await getOnCell().exec(venture.cellId, {
      cmd: parsed.data.cmd,
      timeoutMs: parsed.data.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      idempotencyKey: `web-exec-${randomUUID()}`
    })
    return jsonOk({ result })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}
