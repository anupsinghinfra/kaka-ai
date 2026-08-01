/**
 * GET /api/ventures/[name]/files            — list the cell's root directory.
 * GET /api/ventures/[name]/files?path=src   — list a subdirectory (lazy tree).
 * GET /api/ventures/[name]/files?read=a.js  — read a file's content.
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { extractFileContent, extractFileEntries } from '@/lib/extract'
import { getOnCell } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const venture = getVenture(name)
    if (venture === undefined) {
      return jsonError('VENTURE_NOT_FOUND', `venture "${name}" not found`, 404)
    }
    const url = new URL(request.url)
    const readPath = url.searchParams.get('read')
    if (readPath !== null && readPath.length > 0) {
      const result = await getOnCell().readFile(venture.cellId, readPath)
      const content = extractFileContent(result)
      if (content === undefined) {
        return jsonError('FILE_UNREADABLE', `could not read "${readPath}" from the cell`, 502)
      }
      return jsonOk({ path: readPath, content })
    }
    const dirPath = url.searchParams.get('path') ?? ''
    const result =
      dirPath.length > 0
        ? await getOnCell().listFiles(venture.cellId, dirPath)
        : await getOnCell().listFiles(venture.cellId)
    return jsonOk({ path: dirPath, entries: extractFileEntries(dirPath, result) })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}
