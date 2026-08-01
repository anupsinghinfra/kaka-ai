/**
 * GET    /api/ventures/[name] — venture detail: registry + live cell + remote snapshots.
 * DELETE /api/ventures/[name]?keep_remote=true — remove venture (and cell unless kept).
 */

import { jsonError, jsonOk, toErrorResponse } from '@/lib/api'
import { isBuilderConfigured, getOnCell } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'
import { deleteVenture, fetchCellStatus, VentureNotFoundError } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const venture = getVenture(name)
    if (venture === undefined) {
      return jsonError('VENTURE_NOT_FOUND', `venture "${name}" not found`, 404)
    }
    const [status, remoteSnapshots] = await Promise.all([
      fetchCellStatus(venture.cellId),
      listRemoteSnapshots(venture.cellId)
    ])
    return jsonOk({
      venture: { ...venture, status },
      remoteSnapshots,
      builderReady: isBuilderConfigured()
    })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const keepRemote = new URL(request.url).searchParams.get('keep_remote') === 'true'
    await deleteVenture(name, keepRemote)
    return jsonOk({ deleted: name, keptRemote: keepRemote })
  } catch (error: unknown) {
    if (error instanceof VentureNotFoundError) {
      return jsonError('VENTURE_NOT_FOUND', error.message, 404)
    }
    return toErrorResponse(error)
  }
}

interface RemoteSnapshot {
  readonly key: string
  readonly at?: string
  readonly sizeBytes?: number
}

/** Lists snapshots from OnCell, tolerating errors as an empty list. */
async function listRemoteSnapshots(cellId: string): Promise<readonly RemoteSnapshot[]> {
  try {
    const snapshots = await getOnCell().listSnapshots(cellId)
    return snapshots.map((snapshot) => ({
      key: snapshot.snapshot_key,
      ...(typeof snapshot.created_at === 'string' ? { at: snapshot.created_at } : {}),
      ...(typeof snapshot.size_bytes === 'number' ? { sizeBytes: snapshot.size_bytes } : {})
    }))
  } catch {
    return []
  }
}
