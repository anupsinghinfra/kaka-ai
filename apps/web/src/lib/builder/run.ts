/**
 * Build orchestration: ask Anthropic for a contract-conforming app, write
 * its files into the venture's cell via @platform/oncell, then verify by
 * running the app's self-test in the cell. Emits progress events so the
 * route can stream generating → writing → verifying to the UI.
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { loadRepoEnv } from '../env'
import { getOnCell } from '../oncell'
import { updateVenture, type Venture } from '../registry'
import {
  BUILDER_TOOL_NAME,
  BUILDER_TOOL_SCHEMA,
  DEFAULT_BUILDER_MODEL,
  REQUIRED_CHECK_PATH,
  builderSystemPrompt,
  builderUserPrompt,
  type BuilderApp
} from './contract'
import { parseBuilderResponse } from './parse'

const BUILDER_MAX_TOKENS = 64_000
const CHECK_TIMEOUT_MS = 60_000

export interface BuildCheck {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
}

export interface BuildResult {
  readonly summary: string
  readonly files: readonly string[]
  readonly check: BuildCheck
}

export type BuildEvent =
  | { readonly stage: 'generating' }
  | { readonly stage: 'writing'; readonly files: number }
  | { readonly stage: 'verifying' }

export class BuilderResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuilderResponseError'
  }
}

export function builderModel(): string {
  loadRepoEnv()
  const fromEnv = process.env.KAKA_BUILDER_MODEL
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_BUILDER_MODEL
}

async function requestApp(client: Anthropic, name: string, idea: string): Promise<BuilderApp> {
  const model = builderModel()
  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: BUILDER_TOOL_NAME,
      description:
        'Emit the generated application as a summary plus the complete file set. This is the only way to deliver the app.',
      input_schema: BUILDER_TOOL_SCHEMA,
      strict: true
    }
  ]
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: builderUserPrompt(name, idea) }
  ]

  // Streaming keeps large max_tokens requests clear of HTTP timeouts.
  const first = await client.messages
    .stream({
      model,
      max_tokens: BUILDER_MAX_TOKENS,
      system: builderSystemPrompt(),
      tools,
      messages
    })
    .finalMessage()

  const firstParse = parseBuilderResponse(first.content)
  if (firstParse.ok) {
    return firstParse.app
  }

  // One retry on a malformed response, feeding the failure back verbatim.
  const retry = await client.messages
    .stream({
      model,
      max_tokens: BUILDER_MAX_TOKENS,
      system: builderSystemPrompt(),
      tools,
      messages: [
        ...messages,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content:
            `Your previous response was invalid: ${firstParse.error}. ` +
            `Respond again, strictly within the contract, by calling the ${BUILDER_TOOL_NAME} tool.`
        }
      ]
    })
    .finalMessage()

  const retryParse = parseBuilderResponse(retry.content)
  if (retryParse.ok) {
    return retryParse.app
  }
  throw new BuilderResponseError(
    `builder produced an invalid app twice; last error: ${retryParse.error}`
  )
}

/**
 * Runs a full build for the venture. `onEvent` receives progress stages;
 * the returned result carries the summary, written paths, and check output.
 */
export async function runBuild(
  venture: Venture,
  idea: string,
  onEvent: (event: BuildEvent) => void
): Promise<BuildResult> {
  loadRepoEnv()
  const anthropic = new Anthropic()
  const oncell = getOnCell()

  onEvent({ stage: 'generating' })
  const app = await requestApp(anthropic, venture.name, idea)

  onEvent({ stage: 'writing', files: app.files.length })
  for (const file of app.files) {
    await oncell.writeFile(venture.cellId, file.path, file.content)
  }

  onEvent({ stage: 'verifying' })
  const check = await oncell.exec(venture.cellId, {
    cmd: `node ${REQUIRED_CHECK_PATH}`,
    timeoutMs: CHECK_TIMEOUT_MS,
    idempotencyKey: `web-build-${venture.name}-${randomUUID()}`
  })

  if (check.exit_code === 0) {
    updateVenture(venture.name, { builtAt: new Date().toISOString() })
  }

  return {
    summary: app.summary,
    files: app.files.map((file) => file.path),
    check: { exit_code: check.exit_code, stdout: check.stdout, stderr: check.stderr }
  }
}
