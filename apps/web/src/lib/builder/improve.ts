/**
 * Improve orchestration — one auto-improvement iteration over a built app.
 * Reads the current app out of the cell, snapshots the cell as a rollback
 * point, asks the model (acting as a ruthless product engineer) for the
 * single most valuable user-felt improvement as a full updated file set,
 * writes it, and re-runs the self-test. Every iteration is recorded on the
 * idea's timeline; a failed check is recorded (not rolled back) and fed to
 * the next iteration.
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { loadRepoEnv } from '../env'
import { extractFileContent, extractFileEntries } from '../extract'
import { getOnCell } from '../oncell'
import { nextVersion, recordIteration, updateIdea, type Idea, type Iteration } from '../registry'
import {
  CHECK_OK_MARKER,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  REQUIRED_CHECK_PATH,
  REQUIRED_SERVER_PATH
} from './contract'
import { requestAppViaTool } from './model'
import { CHECK_TIMEOUT_MS, toLastCheck, type BuildCheck } from './run'

export const IMPROVE_TOOL_NAME = 'emit_improvement'

const MAX_TREE_DEPTH = 6
const MAX_READ_FILES = MAX_FILES * 2
const MAX_PROMPT_FILE_CHARS = 48 * 1024
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.kaka', 'node_modules', '.git'])

export interface CurrentFile {
  readonly path: string
  readonly content: string
}

export type ImproveEvent =
  | { readonly stage: 'reading' }
  | { readonly stage: 'snapshotting' }
  | { readonly stage: 'generating' }
  | { readonly stage: 'writing'; readonly files: number }
  | { readonly stage: 'file'; readonly path: string }
  | { readonly stage: 'verifying' }

export interface ImproveResult {
  readonly iteration: Iteration
  readonly files: readonly string[]
  readonly check: BuildCheck
}

/** Thrown when there is no app in the cell to improve yet. */
export class NothingToImproveError extends Error {
  constructor(name: string) {
    super(`idea "${name}" has no built app yet — build v1 first`)
    this.name = 'NothingToImproveError'
  }
}

/** The minimal file-access surface needed to read a cell's app. */
export interface CellFileReader {
  listFiles(cellId: string, path?: string): Promise<unknown>
  readFile(cellId: string, path: string): Promise<unknown>
}

/**
 * Walks the cell's file tree (via list_files) and reads every app file.
 * The .kaka marker directory and dependency/VCS dirs are skipped; reads
 * are capped so a runaway tree cannot blow up the prompt.
 */
export async function readCurrentAppFiles(
  oncell: CellFileReader,
  cellId: string
): Promise<readonly CurrentFile[]> {
  const paths: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH || paths.length >= MAX_READ_FILES) {
      return
    }
    const listed = dir.length > 0 ? await oncell.listFiles(cellId, dir) : await oncell.listFiles(cellId)
    for (const entry of extractFileEntries(dir, listed)) {
      if (entry.type === 'dir') {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await walk(entry.path, depth + 1)
        }
      } else if (paths.length < MAX_READ_FILES) {
        paths.push(entry.path)
      }
    }
  }

  await walk('', 0)

  const files: CurrentFile[] = []
  for (const path of paths) {
    const content = extractFileContent(await oncell.readFile(cellId, path))
    if (content !== undefined) {
      files.push({ path, content: content.slice(0, MAX_PROMPT_FILE_CHARS) })
    }
  }
  return files
}

/** System prompt: a ruthless product engineer shipping one improvement. */
export function improveSystemPrompt(): string {
  return [
    'You are the kaka Improver — a ruthless product engineer who ships exactly one meaningful improvement per iteration to a small, working app.',
    '',
    "You are given the founder's startup idea, the app's complete current source, the latest self-test output, and the changelog of previous iterations.",
    '',
    'Your job: pick the SINGLE most valuable improvement a real user of this app would immediately feel, and ship it. Not a refactor, not a cleanup, not a rewrite — one concrete improvement to what the product does or how it feels to use.',
    'If the latest self-test FAILED, the single most valuable improvement is always the same: make the app pass its self-test again.',
    'Never repeat an improvement already in the changelog.',
    '',
    'Hard constraints (identical to the original build; the sandbox rejects anything else):',
    '- Node 22 standard library ONLY. The sandbox has NO network access and NO npm install. Never reference npm packages, package installation, or external URLs at runtime.',
    `- At most ${MAX_FILES} files and ${MAX_TOTAL_BYTES} bytes of content in total.`,
    '- All paths are relative (e.g. "src/app.js"). No leading "/", no "..", no duplicates.',
    `- The entry point stays "${REQUIRED_SERVER_PATH}": an HTTP server that listens on process.env.PORT || 3000 and serves the product's user interface at "/" plus its API routes. Plain "node ${REQUIRED_SERVER_PATH}" must start it with no flags.`,
    `- You MUST include "${REQUIRED_CHECK_PATH}": a self-test that exercises the app's core logic — including your new improvement — prints "${CHECK_OK_MARKER}" on success, and exits non-zero on failure. It must run with plain "node ${REQUIRED_CHECK_PATH}" from the app root.`,
    `- ${REQUIRED_CHECK_PATH} must start the server on an ephemeral port (listen on port 0) and test it over real HTTP against "127.0.0.1" — NEVER the hostname "localhost"; the sandbox has no name resolution.`,
    '- Keep the module system the current app already uses.',
    '',
    'Return the COMPLETE updated file set: every file the app needs, with full contents, including files you did not change. The summary must be ONE changelog line written for users, e.g. "Added per-person rounding so split totals always match the bill."',
    `Respond by calling the ${IMPROVE_TOOL_NAME} tool with {summary, files}. If for any reason you cannot call the tool, respond with EXACTLY one fenced \`\`\`json code block containing the same {"summary", "files"} object and nothing else.`
  ].join('\n')
}

export interface ImprovePromptInput {
  readonly name: string
  readonly idea: string
  readonly version: number
  readonly iterations: readonly Iteration[]
  readonly lastCheck: { readonly exitCode: number; readonly output: string } | undefined
  readonly files: readonly CurrentFile[]
}

/** User prompt: idea + changelog + latest check + full current source. */
export function improveUserPrompt(input: ImprovePromptInput): string {
  const changelog =
    input.iterations.length > 0
      ? input.iterations
          .map(
            (iteration) =>
              `- v${iteration.v} (${iteration.checkPassed ? 'check passed' : 'check FAILED'}): ${iteration.summary}`
          )
          .join('\n')
      : '- (no iterations recorded)'
  const checkSection =
    input.lastCheck !== undefined
      ? `exit ${input.lastCheck.exitCode}\n${input.lastCheck.output.length > 0 ? input.lastCheck.output : '(no output)'}`
      : '(not yet run)'
  const fileSections = input.files
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join('\n\n')
  return [
    `Startup idea "${input.name}":`,
    input.idea,
    '',
    `You are shipping v${input.version}.`,
    '',
    'Changelog so far:',
    changelog,
    '',
    `Latest self-test output (node ${REQUIRED_CHECK_PATH}):`,
    checkSection,
    '',
    'Current source files:',
    fileSections,
    '',
    `Ship v${input.version}: the single most valuable user-felt improvement, as the complete updated file set.`
  ].join('\n')
}

/**
 * Runs one improve iteration for the idea. `onEvent` receives progress
 * stages; the returned result carries the recorded iteration, the written
 * paths, and the check output.
 */
export async function runImprove(
  idea: Idea,
  ideaText: string,
  onEvent: (event: ImproveEvent) => void
): Promise<ImproveResult> {
  loadRepoEnv()
  const anthropic = new Anthropic()
  const oncell = getOnCell()

  onEvent({ stage: 'reading' })
  const currentFiles = await readCurrentAppFiles(oncell, idea.cellId)
  if (currentFiles.length === 0) {
    throw new NothingToImproveError(idea.name)
  }

  // Snapshot BEFORE touching anything — the rollback point for this iteration.
  onEvent({ stage: 'snapshotting' })
  const snapshot = await oncell.snapshotCell(idea.cellId)

  onEvent({ stage: 'generating' })
  const v = nextVersion(idea)
  const app = await requestAppViaTool(anthropic, {
    system: improveSystemPrompt(),
    user: improveUserPrompt({
      name: idea.name,
      idea: ideaText,
      version: v,
      iterations: idea.iterations,
      lastCheck: idea.lastCheck,
      files: currentFiles
    }),
    toolName: IMPROVE_TOOL_NAME,
    toolDescription:
      'Emit the improved application as a one-line user-facing changelog summary plus the complete updated file set. This is the only way to deliver the improvement.'
  })

  onEvent({ stage: 'writing', files: app.files.length })
  for (const file of app.files) {
    await oncell.writeFile(idea.cellId, file.path, file.content)
    onEvent({ stage: 'file', path: file.path })
  }

  onEvent({ stage: 'verifying' })
  const check = await oncell.exec(idea.cellId, {
    cmd: `node ${REQUIRED_CHECK_PATH}`,
    timeoutMs: CHECK_TIMEOUT_MS,
    idempotencyKey: `web-improve-${idea.name}-${randomUUID()}`
  })

  const iteration: Iteration = {
    v,
    summary: app.summary,
    at: new Date().toISOString(),
    checkPassed: check.exit_code === 0,
    snapshotKey: snapshot.snapshot_key
  }
  recordIteration(idea.name, iteration)
  // A failed check is not rolled back — it is recorded and fed forward so
  // the next iteration's top priority is fixing it.
  updateIdea(idea.name, { lastCheck: toLastCheck(check) })

  return {
    iteration,
    files: app.files.map((file) => file.path),
    check: { exit_code: check.exit_code, stdout: check.stdout, stderr: check.stderr }
  }
}
