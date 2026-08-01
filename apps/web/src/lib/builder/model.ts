/**
 * Shared Anthropic request flow for the Builder and the Improver: stream a
 * tool-use request, parse strictly against the contract, and retry exactly
 * once with the parse failure fed back verbatim.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { loadRepoEnv } from '../env'
import { BUILDER_TOOL_SCHEMA, DEFAULT_BUILDER_MODEL, type BuilderApp } from './contract'
import { parseBuilderResponse } from './parse'

export const MODEL_MAX_TOKENS = 64_000

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

export interface ModelAppRequest {
  readonly system: string
  readonly user: string
  readonly toolName: string
  readonly toolDescription: string
}

/**
 * Requests a contract-conforming app from the model. Streaming keeps large
 * max_tokens requests clear of HTTP timeouts. One retry on a malformed
 * response, feeding the failure back verbatim.
 */
export async function requestAppViaTool(
  client: Anthropic,
  request: ModelAppRequest
): Promise<BuilderApp> {
  const model = builderModel()
  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: request.toolName,
      description: request.toolDescription,
      input_schema: BUILDER_TOOL_SCHEMA,
      strict: true
    }
  ]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.user }]

  const first = await client.messages
    .stream({ model, max_tokens: MODEL_MAX_TOKENS, system: request.system, tools, messages })
    .finalMessage()

  const firstParse = parseBuilderResponse(first.content, request.toolName)
  if (firstParse.ok) {
    return firstParse.app
  }

  const retry = await client.messages
    .stream({
      model,
      max_tokens: MODEL_MAX_TOKENS,
      system: request.system,
      tools,
      messages: [
        ...messages,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content:
            `Your previous response was invalid: ${firstParse.error}. ` +
            `Respond again, strictly within the contract, by calling the ${request.toolName} tool.`
        }
      ]
    })
    .finalMessage()

  const retryParse = parseBuilderResponse(retry.content, request.toolName)
  if (retryParse.ok) {
    return retryParse.app
  }
  throw new BuilderResponseError(
    `builder produced an invalid app twice; last error: ${retryParse.error}`
  )
}
