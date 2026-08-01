/**
 * Cell → registry synchronization. In agent mode the IDEA's cell is the
 * source of truth for the iteration timeline (`kaka:iterations`) and the
 * auto-improve state (`kaka:auto` / `kaka:next-wake`): the Builder keeps
 * improving while no browser is open, so kaka adopts the cell's record
 * whenever it looks at the idea.
 */

import type { OnCellClient } from '@platform/oncell'
import { getIdea, updateIdea, type Idea, type Iteration } from '../registry'
import { AUTO_KEY, ITERATIONS_KEY, NEXT_WAKE_KEY } from './agent-def'
import { parseCellIterations } from './progress'

export type AutoImproveFlag = 'on' | 'off'

export interface AutoImproveState {
  readonly auto: AutoImproveFlag
  readonly nextWakeAt?: string
}

/** Reads and validates the cell's iteration timeline (undefined on failure). */
export async function readCellIterations(
  oncell: OnCellClient,
  cellId: string
): Promise<readonly Iteration[] | undefined> {
  try {
    const result = await oncell.kvGet(cellId, ITERATIONS_KEY)
    return parseCellIterations(result.value)
  } catch {
    return undefined
  }
}

/**
 * Adopts the cell's iteration timeline into the registry. A missing or
 * unreadable timeline changes nothing. Returns the (possibly updated) idea.
 */
export async function syncIterationsFromCell(oncell: OnCellClient, idea: Idea): Promise<Idea> {
  const iterations = await readCellIterations(oncell, idea.cellId)
  if (iterations === undefined || iterations.length === 0) {
    return idea
  }
  const current = getIdea(idea.name)
  if (current === undefined) {
    return idea
  }
  const unchanged = JSON.stringify(current.iterations) === JSON.stringify(iterations)
  const v1 = iterations.find((iteration) => iteration.v === 1)
  const builtAt =
    current.builtAt === undefined && v1 !== undefined && v1.checkPassed ? v1.at : current.builtAt
  if (unchanged && builtAt === current.builtAt) {
    return current
  }
  return updateIdea(idea.name, {
    iterations: [...iterations],
    ...(builtAt !== undefined ? { builtAt } : {})
  })
}

/** Reads the auto-improve toggle + next wake from the cell (tolerant). */
export async function readAutoImproveState(
  oncell: OnCellClient,
  cellId: string
): Promise<AutoImproveState> {
  try {
    const [autoResult, wakeResult] = await Promise.all([
      oncell.kvGet(cellId, AUTO_KEY),
      oncell.kvGet(cellId, NEXT_WAKE_KEY)
    ])
    const auto: AutoImproveFlag = autoResult.value === 'on' ? 'on' : 'off'
    const nextWakeAt =
      typeof wakeResult.value === 'string' && wakeResult.value.length > 0
        ? wakeResult.value
        : undefined
    return { auto, ...(nextWakeAt !== undefined ? { nextWakeAt } : {}) }
  } catch {
    return { auto: 'off' }
  }
}
