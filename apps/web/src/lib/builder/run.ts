/**
 * Build orchestration: ask Anthropic for a contract-conforming app, write
 * its files into the idea's cell via @platform/oncell, then verify by
 * running the app's self-test in the cell. A successful build is v1 of the
 * idea — the iteration timeline is reset to that single entry. Emits
 * progress events so the route can stream generating → writing → verifying
 * to the UI.
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { loadRepoEnv } from '../env'
import { getOnCell } from '../oncell'
import { updateIdea, type Idea, type Iteration, type LastCheck } from '../registry'
import {
  BUILDER_TOOL_NAME,
  REQUIRED_CHECK_PATH,
  builderSystemPrompt,
  builderUserPrompt
} from './contract'
import { requestAppViaTool } from './model'

export const CHECK_TIMEOUT_MS = 60_000
const MAX_CHECK_OUTPUT_CHARS = 4000

export interface BuildCheck {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
}

export interface BuildResult {
  readonly summary: string
  readonly files: readonly string[]
  readonly check: BuildCheck
  readonly iteration: Iteration
}

export type BuildEvent =
  | { readonly stage: 'generating' }
  | { readonly stage: 'writing'; readonly files: number }
  | { readonly stage: 'verifying' }

/** Condenses a check result for the registry and the next improve prompt. */
export function toLastCheck(check: BuildCheck): LastCheck {
  const combined = [
    check.stdout.trim(),
    check.stderr.trim().length > 0 ? `[stderr]\n${check.stderr.trim()}` : ''
  ]
    .filter((part) => part.length > 0)
    .join('\n')
  return { exitCode: check.exit_code, output: combined.slice(0, MAX_CHECK_OUTPUT_CHARS) }
}

/**
 * Runs a full build for the idea. `onEvent` receives progress stages; the
 * returned result carries the summary, written paths, check output, and
 * the recorded v1 iteration.
 */
export async function runBuild(
  idea: Idea,
  ideaText: string,
  onEvent: (event: BuildEvent) => void
): Promise<BuildResult> {
  loadRepoEnv()
  const anthropic = new Anthropic()
  const oncell = getOnCell()

  onEvent({ stage: 'generating' })
  const app = await requestAppViaTool(anthropic, {
    system: builderSystemPrompt(),
    user: builderUserPrompt(idea.name, ideaText),
    toolName: BUILDER_TOOL_NAME,
    toolDescription:
      'Emit the generated application as a summary plus the complete file set. This is the only way to deliver the app.'
  })

  onEvent({ stage: 'writing', files: app.files.length })
  for (const file of app.files) {
    await oncell.writeFile(idea.cellId, file.path, file.content)
  }

  onEvent({ stage: 'verifying' })
  const check = await oncell.exec(idea.cellId, {
    cmd: `node ${REQUIRED_CHECK_PATH}`,
    timeoutMs: CHECK_TIMEOUT_MS,
    idempotencyKey: `web-build-${idea.name}-${randomUUID()}`
  })

  const checkPassed = check.exit_code === 0
  const at = new Date().toISOString()
  const iteration: Iteration = { v: 1, summary: app.summary, at, checkPassed }
  // A build regenerates the whole app, so the timeline restarts at v1.
  updateIdea(idea.name, {
    ...(checkPassed ? { builtAt: at } : {}),
    iterations: [iteration],
    lastCheck: toLastCheck(check)
  })

  return {
    summary: app.summary,
    files: app.files.map((file) => file.path),
    check: { exit_code: check.exit_code, stdout: check.stdout, stderr: check.stderr },
    iteration
  }
}
