/**
 * Builder mode selection. The platform default is "agent": every idea is
 * built and improved by its own OnCell Builder agent. "local" is the
 * explicit escape hatch (KAKA_BUILDER_MODE=local) that keeps the original
 * in-process Anthropic builder path — never a silent fallback.
 */

import { loadRepoEnv } from '../env'

export type BuilderMode = 'agent' | 'local'

/** The active builder mode; anything but "local" means "agent". */
export function builderMode(): BuilderMode {
  loadRepoEnv()
  return process.env.KAKA_BUILDER_MODE === 'local' ? 'local' : 'agent'
}
