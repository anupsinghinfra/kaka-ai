/**
 * Builder response parsing — strict validation of the model's output
 * against the contract. Accepts a tool_use block (preferred) or a single
 * fenced ```json block. Returns a Result so the caller can retry once with
 * the failure message as feedback.
 */

import { z } from 'zod'
import {
  BUILDER_TOOL_NAME,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  REQUIRED_CHECK_PATH,
  type BuilderApp
} from './contract'

/** Structural view of an Anthropic content block (SDK-independent for tests). */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly input?: unknown
}

export type ParseResult =
  | { readonly ok: true; readonly app: BuilderApp }
  | { readonly ok: false; readonly error: string }

const builderAppSchema = z.object({
  summary: z.string().min(1, 'summary must be a non-empty string'),
  files: z
    .array(
      z.object({
        path: z.string().min(1, 'file path must be non-empty'),
        content: z.string()
      })
    )
    .min(1, 'files must contain at least one file')
})

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/

function fail(error: string): ParseResult {
  return { ok: false, error }
}

function isSafeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false
  }
  const segments = path.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Validates a candidate payload against the full Builder contract. */
export function validateBuilderApp(candidate: unknown): ParseResult {
  const parsed = builderAppSchema.safeParse(candidate)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ')
    return fail(`payload does not match {summary, files:[{path, content}]}: ${detail}`)
  }
  const { summary, files } = parsed.data
  if (files.length > MAX_FILES) {
    return fail(`too many files: ${files.length} (max ${MAX_FILES})`)
  }
  const seen = new Set<string>()
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      return fail(`unsafe file path "${file.path}": paths must be relative, with no ".." segments`)
    }
    if (seen.has(file.path)) {
      return fail(`duplicate file path "${file.path}"`)
    }
    seen.add(file.path)
  }
  const totalBytes = files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content, 'utf8'),
    0
  )
  if (totalBytes > MAX_TOTAL_BYTES) {
    return fail(`total content is ${totalBytes} bytes (max ${MAX_TOTAL_BYTES})`)
  }
  if (!seen.has(REQUIRED_CHECK_PATH)) {
    return fail(`missing required self-test file "${REQUIRED_CHECK_PATH}"`)
  }
  return { ok: true, app: { summary, files } }
}

/**
 * Extracts and validates the Builder payload from a model response's
 * content blocks: the emit_app tool_use input first, then a fenced JSON
 * block in the text.
 */
export function parseBuilderResponse(content: readonly ContentBlockLike[]): ParseResult {
  const toolBlock = content.find(
    (block) => block.type === 'tool_use' && block.name === BUILDER_TOOL_NAME
  )
  if (toolBlock !== undefined) {
    return validateBuilderApp(toolBlock.input)
  }

  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  const fenced = FENCED_JSON_RE.exec(text)
  const rawJson = fenced !== null ? fenced[1] : text.trim().startsWith('{') ? text.trim() : undefined
  if (rawJson === undefined) {
    return fail(`response contained neither a ${BUILDER_TOOL_NAME} tool call nor a fenced JSON block`)
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(rawJson)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(`fenced block is not valid JSON: ${message}`)
  }
  return validateBuilderApp(candidate)
}
