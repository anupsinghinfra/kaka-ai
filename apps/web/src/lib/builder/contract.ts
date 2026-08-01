/**
 * The Builder contract: what the model must produce, and the shared types
 * and limits used by the parser and the build orchestrator.
 */

export const MAX_FILES = 20
export const MAX_TOTAL_BYTES = 200 * 1024
export const REQUIRED_CHECK_PATH = 'src/check.js'
export const CHECK_OK_MARKER = 'CHECK_OK'
export const BUILDER_TOOL_NAME = 'emit_app'
export const DEFAULT_BUILDER_MODEL = 'claude-sonnet-5'

export interface BuilderFile {
  readonly path: string
  readonly content: string
}

export interface BuilderApp {
  readonly summary: string
  readonly files: readonly BuilderFile[]
}

/** JSON schema for the emit_app tool (strict tool use). */
export const BUILDER_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: {
      type: 'string' as const,
      description: 'One or two sentences describing the app that was generated.'
    },
    files: {
      type: 'array' as const,
      description: 'Complete file set for the app.',
      items: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string' as const,
            description: 'Relative path, e.g. src/server.js. No leading slash, no "..".'
          },
          content: { type: 'string' as const, description: 'Full file content.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'files'],
  additionalProperties: false
}

/** System prompt enforcing the sandbox constraints. */
export function builderSystemPrompt(): string {
  return [
    'You are the kaka Builder. You generate a SMALL, self-contained Node.js 22 application from a founder\'s idea.',
    '',
    'Hard constraints (the sandbox will reject anything else):',
    '- Node 22 standard library ONLY. The sandbox has NO network access and NO npm install. Never reference npm packages, package installation, or external URLs at runtime.',
    `- At most ${MAX_FILES} files and ${MAX_TOTAL_BYTES} bytes of content in total. Keep it small and focused.`,
    '- All paths are relative (e.g. "src/app.js"). No leading "/", no "..", no duplicates.',
    `- You MUST include "${REQUIRED_CHECK_PATH}": a self-test that exercises the app\'s core logic, prints "${CHECK_OK_MARKER}" on success, and exits non-zero on failure. It must run with plain "node ${REQUIRED_CHECK_PATH}" from the app root.`,
    '- CommonJS (require) or ESM with .mjs — pick one and be consistent. If you include a package.json it must not declare dependencies.',
    '',
    `Respond by calling the ${BUILDER_TOOL_NAME} tool with {summary, files}. If for any reason you cannot call the tool, respond with EXACTLY one fenced \`\`\`json code block containing the same {"summary", "files"} object and nothing else.`
  ].join('\n')
}

/** User prompt for a build request. */
export function builderUserPrompt(name: string, idea: string): string {
  return [
    `Idea name: ${name}`,
    '',
    'Idea:',
    idea,
    '',
    'Generate the smallest real app that demonstrates this idea end to end, within the contract.'
  ].join('\n')
}
