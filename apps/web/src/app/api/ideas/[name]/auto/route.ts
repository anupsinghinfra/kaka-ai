/**
 * Auto-improve toggle — durable and server-side.
 *
 * GET  /api/ideas/[name]/auto  → {auto: "on"|"off", nextWakeAt?}
 * POST /api/ideas/[name]/auto  {auto: "on"|"off"}
 *
 * The flag lives in the IDEA's cell (kv `kaka:auto`), where the Builder
 * agent reads it at the end of every run to decide whether to schedule its
 * own next wake — so improvement continues with every browser closed.
 * Turning auto on for a built idea kicks one improve task (fire-and-forget)
 * to start the chain; each run then schedules the next.
 */

import { jsonError, jsonOk, readJsonBody, toErrorResponse } from '@/lib/api'
import { AUTO_KEY, builderAgentName } from '@/lib/builder-agent/agent-def'
import { deployBuilderAgent } from '@/lib/builder-agent/deploy'
import { builderMode } from '@/lib/builder-agent/mode'
import { readAutoImproveState } from '@/lib/builder-agent/sync'
import { getOnCell } from '@/lib/oncell'
import { currentVersion, getIdea, type Idea } from '@/lib/registry'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ name: string }> }

const autoToggleSchema = z.object({ auto: z.enum(['on', 'off']) })

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const idea = getIdea(name)
  if (idea === undefined) {
    return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
  }
  const state = await readAutoImproveState(getOnCell(), idea.cellId)
  return jsonOk(state)
}

/** Starts the improvement chain: deploy current identity, fire "improve". */
async function kickImproveChain(idea: Idea, ideaText: string): Promise<void> {
  const oncell = getOnCell()
  await deployBuilderAgent(oncell, idea.name, ideaText)
  const snapshot = await oncell.snapshotCell(idea.cellId)
  // Fire-and-forget: the agent reports through the cell's kv, and every
  // page load / poll syncs the registry from there.
  void oncell
    .invokeAgentTask(builderAgentName(idea.name), 'improve', {
      cell_id: idea.cellId,
      run: `auto-kick-${Date.now().toString(36)}`,
      snapshot_key: snapshot.snapshot_key
    })
    .catch(() => {
      // The chain simply does not start; the toggle stays on and the next
      // manual improve (or toggle cycle) retries. Nothing to surface here —
      // the response has already been sent.
    })
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { name } = await context.params
  const idea = getIdea(name)
  if (idea === undefined) {
    return jsonError('IDEA_NOT_FOUND', `idea "${name}" not found`, 404)
  }
  if (builderMode() === 'local') {
    return jsonError(
      'AUTO_UNAVAILABLE_LOCAL',
      'durable auto-improve needs agent mode',
      409,
      'Unset KAKA_BUILDER_MODE=local to let the Builder agent improve on its own.'
    )
  }
  const parsed = autoToggleSchema.safeParse(await readJsonBody(request))
  if (!parsed.success) {
    return jsonError('VALIDATION_ERROR', 'body must be {auto: "on"|"off"}', 400)
  }
  const { auto } = parsed.data

  try {
    await getOnCell().kvSet(idea.cellId, AUTO_KEY, auto)
    const shouldKick =
      auto === 'on' &&
      currentVersion(idea) > 0 &&
      idea.idea !== undefined &&
      idea.idea.trim().length > 0
    if (shouldKick) {
      await kickImproveChain(idea, idea.idea as string)
    }
    return jsonOk({ auto, kicked: shouldKick })
  } catch (error: unknown) {
    return toErrorResponse(error)
  }
}
