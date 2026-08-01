/**
 * GET /api/ventures/[name]/journal — the cell's recent journal entries.
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { extractJournalEntries } from '@/lib/extract'
import { getOnCell } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

const MAX_JOURNAL_ENTRIES = 50

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const venture = getVenture(name)
    if (venture === undefined) {
      return jsonError('VENTURE_NOT_FOUND', `venture "${name}" not found`, 404)
    }
    const raw = await getOnCell().journal(venture.cellId)
    const entries = extractJournalEntries(raw).slice(-MAX_JOURNAL_ENTRIES)
    return jsonOk({ entries })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}
