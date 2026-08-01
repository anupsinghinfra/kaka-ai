/**
 * GET    /api/ideas/[name] — idea detail: registry + live cell + remote snapshots.
 * PATCH  /api/ideas/[name] — update the idea text.
 * DELETE /api/ideas/[name]?keep_remote=true — remove idea (and cell unless kept).
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { deleteIdea, fetchCellStatus, IdeaNotFoundError, refreshCellIdea } from '@/lib/ideas'
import { getOnCell, isBuilderConfigured } from '@/lib/oncell'
import { getIdea, updateIdea } from '@/lib/registry'
import { updateIdeaSchema } from '@/lib/validation'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const idea = getIdea(name)
    if (idea === undefined) {
      return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
    }
    const [status, remoteSnapshots] = await Promise.all([
      fetchCellStatus(idea.cellId),
      listRemoteSnapshots(idea.cellId)
    ])
    return jsonOk({
      idea: { ...idea, status },
      remoteSnapshots,
      builderReady: isBuilderConfigured()
    })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    if (getIdea(name) === undefined) {
      return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
    }
    const body = await readJsonBody(request)
    const parsed = updateIdeaSchema.safeParse(body)
    if (!parsed.success) {
      return toErrorResponse(parsed.error)
    }
    const idea = updateIdea(name, { idea: parsed.data.idea })
    // Keep the in-cell idea file in step — it is the Builder's evidence
    // source for "what the founder wants now". Best-effort: the registry is
    // already updated, and every kaka-fired run redeploys with fresh text.
    try {
      await refreshCellIdea(idea)
    } catch {
      // Tolerated — self-scheduled runs will still see it on the next edit.
    }
    return jsonOk({ idea })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { name } = await context.params
    const keepRemote = new URL(request.url).searchParams.get('keep_remote') === 'true'
    await deleteIdea(name, keepRemote)
    return jsonOk({ deleted: name, keptRemote: keepRemote })
  } catch (error: unknown) {
    if (error instanceof IdeaNotFoundError) {
      return jsonError('IDEA_NOT_FOUND', error.message, 404)
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
