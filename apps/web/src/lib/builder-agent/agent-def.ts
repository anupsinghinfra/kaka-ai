/**
 * The Builder agent definition — one OnCell agent per idea, named
 * `builder-{idea}`. This module owns everything the agent IS: its identity
 * prompt (idea text embedded), its single "improve" skill, the deploy
 * manifest (identity / capabilities / skills wire contract), and the run
 * briefing template its task code fills in per run.
 *
 * The agent does all of its work in ONE agent.llm loop: the manifest
 * capabilities ("cells", "schedule") become dynamic tools inside that loop,
 * and there is no task-code API for another cell's files — so the model
 * itself writes files, runs checks, starts the service, and records
 * progress through the cells_* tools.
 */

import type { AgentManifest } from '@platform/oncell'
import {
  CHECK_OK_MARKER,
  DEFAULT_BUILDER_MODEL,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  REQUIRED_CHECK_PATH,
  REQUIRED_SERVER_PATH
} from '../builder/contract'

/** Daily spend ceiling for one Builder agent, in cents. */
export const BUILDER_BUDGET_PER_DAY_CENTS = 500

/** Delay before a self-scheduled improvement wakes the agent. */
export const AUTO_IMPROVE_WAKE_IN = '30 minutes'

/** Capabilities granted to every Builder agent. */
export const BUILDER_CAPABILITIES = ['memory', 'cells', 'schedule'] as const

// In-cell KV keys the Builder reads/writes on the IDEA's cell.
export const PROGRESS_KEY = 'kaka:progress'
export const ITERATIONS_KEY = 'kaka:iterations'
export const AUTO_KEY = 'kaka:auto'
export const NEXT_WAKE_KEY = 'kaka:next-wake'

/** Maximum progress entries kept in the cell (the agent trims older ones). */
export const MAX_PROGRESS_ENTRIES = 200

/** In-cell marker file holding the canonical idea text (seeded by kaka). */
export const IDEA_FILE_PATH = '.kaka/idea.json'

/** The app's own runtime self-log — the evidence improve runs read. */
export const APP_LOG_PATH = 'app.log'
/** Self-log size cap before the app rewrites it (newest half kept). */
export const APP_LOG_MAX_BYTES = 64_000
/** Lines of the self-log an improve run tails for runtime evidence. */
export const APP_LOG_TAIL_LINES = 200

/** The deployed agent name for an idea. */
export function builderAgentName(ideaName: string): string {
  return `builder-${ideaName}`
}

/** Identity: who this agent is — a product engineer for exactly one idea. */
export function builderIdentityInstructions(ideaName: string, ideaText: string): string {
  return [
    `You are the kaka Builder for the startup idea "${ideaName}" — a ruthless product engineer whose entire job is to build this one product and relentlessly improve it.`,
    '',
    'The idea:',
    ideaText,
    '',
    "You operate the idea's OnCell cell exclusively through the cells_* tools; the cell id and run protocol arrive in each run briefing. All app code lives in that cell — never in your own files.",
    '',
    'The app contract (the sandbox rejects anything else):',
    '- Node 22 standard library ONLY. The cell has NO network access and NO npm install. Never reference npm packages or external URLs at runtime.',
    `- At most ${MAX_FILES} files and ${MAX_TOTAL_BYTES} bytes of content in total. Keep it small and focused.`,
    '- All paths are relative (e.g. "src/app.js"). No leading "/", no "..", no duplicates. Never touch the .kaka directory.',
    `- The entry point MUST be "${REQUIRED_SERVER_PATH}": an HTTP server (node:http) listening on process.env.PORT || 3000 that serves the product's user interface at "/" plus any API routes it needs. Plain "node ${REQUIRED_SERVER_PATH}" must start it with no flags.`,
    `- You MUST keep "${REQUIRED_CHECK_PATH}" current: a self-test that starts the server from ${REQUIRED_SERVER_PATH} on an ephemeral port (listen on port 0), makes real HTTP requests to "127.0.0.1" (NEVER the hostname "localhost" — the sandbox has no name resolution), asserts the responses, prints "${CHECK_OK_MARKER}" on success, and exits 0 (non-zero on failure).`,
    '- CommonJS (require) or ESM with .mjs — pick one and stay consistent. A package.json must not declare dependencies.',
    `- The server MUST keep a small self-log at "${APP_LOG_PATH}": append one short line (ISO timestamp + what happened) with node:fs appendFileSync for every startup, handled error, and non-2xx response; when the file exceeds ${APP_LOG_MAX_BYTES} bytes, rewrite it keeping only the newest half. This log is the ONLY runtime evidence your future improve runs can read — without it you are improving blind.`,
    '',
    'Record-keeping (kv on the idea cell via cells_kv_get / cells_kv_set; every value is a JSON string):',
    `- "${PROGRESS_KEY}": JSON array of progress entries {"ts","run","stage","detail"?}. Always read-modify-write: get, parse (missing/invalid means []), push, keep only the newest ${MAX_PROGRESS_ENTRIES}, set.`,
    `- "${ITERATIONS_KEY}": JSON array of shipped versions {"v","summary","at","checkPassed","snapshotKey"?}. The summary is ONE changelog line written for users.`,
    `- "${AUTO_KEY}": "on" means the founder wants you improving on your own schedule.`,
    `- "${NEXT_WAKE_KEY}": ISO timestamp of your next scheduled wake ("" when none).`
  ].join('\n')
}

/** The improve skill: description rides in base context; instructions load on demand. */
export const IMPROVE_SKILL_NAME = 'improve'

export const IMPROVE_SKILL_DESCRIPTION =
  "Ship the single most user-felt improvement to the idea's app: gather evidence (idea file, app, changelog, runtime log), pick, improve, verify, restart, record."

export function improveSkillInstructions(): string {
  return [
    'One improvement per run — evidence first, then pick, then ship:',
    '',
    '1. Gather evidence — NEVER pick an improvement blind:',
    `   a. cells_read_file "${IDEA_FILE_PATH}" — the founder may have edited the idea since you were deployed; the idea text in this file is authoritative for this run and overrides anything you remember. (Reading .kaka is expected; writing to it is forbidden.)`,
    `   b. Read the current app: cells_list_files, then cells_read_file each app file (skip .kaka, node_modules, .git, ${APP_LOG_PATH}). Read the changelog from kv "${ITERATIONS_KEY}".`,
    `   c. Runtime signals: cells_exec {"cmd":"[ -f ${APP_LOG_PATH} ] && tail -n ${APP_LOG_TAIL_LINES} ${APP_LOG_PATH} || echo NO_APP_LOG"} — the app's self-log. Scan it for errors, crashes, restarts, and usage patterns (which routes real users actually hit).`,
    '2. If the latest self-test FAILED, the single most valuable improvement is always the same: make the app pass its self-test again.',
    `3. Observed runtime errors OUTRANK new features: if the self-log shows the app failing for users (errors, crashes, restart storms), fixing that failure IS the single most valuable improvement this run — ship the fix, not a feature.`,
    '4. Otherwise pick the SINGLE most valuable improvement a real user of this product would immediately feel. Not a refactor, not a cleanup, not a rewrite — one concrete improvement to what the product does or how it feels to use. Never repeat an improvement already in the changelog.',
    '5. When evidence drove the pick, the changelog line says so — e.g. "Fixed crash on empty ingredient list (seen in logs)".',
    `6. Write the COMPLETE updated file set with cells_write_file — every file the app needs, full contents, including files you did not change. Update ${REQUIRED_CHECK_PATH} so it exercises the new improvement.`,
    '7. Verify, restart the service, and record the iteration exactly as the run briefing prescribes.'
  ].join('\n')
}

// Placeholders the agent's task code substitutes into the briefing.
export const BRIEFING_KIND = '{{KIND}}'
export const BRIEFING_CELL_ID = '{{CELL_ID}}'
export const BRIEFING_RUN = '{{RUN}}'
export const BRIEFING_SNAPSHOT_KEY = '{{SNAPSHOT_KEY}}'
export const BRIEFING_AUTO_PREAMBLE = '{{AUTO_PREAMBLE}}'
export const BRIEFING_DIRECTION_BLOCK = '{{DIRECTION_BLOCK}}'

/** Inner placeholder of founderDirectionBlock() the task code fills in. */
export const DIRECTION_PLACEHOLDER = '{{DIRECTION}}'

/**
 * Briefing block for a founder-directed revision (manual improve runs that
 * carry a `direction` task arg). When no direction is present, the task
 * code substitutes an empty string and the agent picks per its skill.
 */
export function founderDirectionBlock(): string {
  return [
    `The founder has directed this revision: ${DIRECTION_PLACEHOLDER}`,
    'This directive IS the single improvement to ship this run — do not substitute your own pick. Interpret it as a product engineer (the smallest excellent version of what they asked), still verify with the self-test, and record the changelog line as usual.',
    ''
  ].join('\n')
}

/** Guard prepended to self-scheduled runs so toggling auto off stops the chain. */
export function autoRunPreamble(): string {
  return [
    `This is a self-scheduled run. FIRST read kv "${AUTO_KEY}": if its value is not exactly "on", append {"stage":"done","detail":"auto-improve is off — skipped"} to "${PROGRESS_KEY}", set "${NEXT_WAKE_KEY}" to "", and STOP without changing anything else.`,
    ''
  ].join('\n')
}

/**
 * The per-run briefing. Static text lives here (kaka-side, testable); the
 * agent's task code only substitutes the placeholders.
 */
export function runBriefingTemplate(): string {
  return [
    `Run briefing — ${BRIEFING_KIND} run "${BRIEFING_RUN}" for cell "${BRIEFING_CELL_ID}".`,
    '',
    BRIEFING_AUTO_PREAMBLE,
    BRIEFING_DIRECTION_BLOCK,
    `Work strictly through your tools against cell_id "${BRIEFING_CELL_ID}". After each stage below, append a progress entry {"ts":"<ISO now>","run":"${BRIEFING_RUN}","stage":...,"detail"?:...} to kv "${PROGRESS_KEY}" (read-modify-write as your identity prescribes).`,
    '',
    'Stages, in order:',
    `1. build runs: append {"stage":"generating"} and design the smallest real app that demonstrates the idea end to end, within the app contract. improve runs: append {"stage":"reading"}, then follow your improve skill's evidence protocol (idea file, full app + changelog, runtime self-log) before picking the one improvement — a founder directive above IS that improvement; then append {"stage":"generating"}.`,
    '2. Append {"stage":"writing"}. Write every file with cells_write_file, appending {"stage":"file","detail":"<path>"} after each file.',
    `3. Append {"stage":"verifying"}. Run the self-test: cells_exec {"cell_id":"${BRIEFING_CELL_ID}","cmd":"node ${REQUIRED_CHECK_PATH}","timeout_ms":60000}. Then append {"stage":"checked","detail":"<JSON string {\\"exitCode\\":<exit code>,\\"output\\":\\"<first 400 chars of combined stdout+stderr>\\"}>"}.`,
    '4. If the check failed, fix the app and repeat stages 2-3 once. If it still fails, continue — a failed check is recorded, never hidden.',
    `5. Append {"stage":"starting"}. cells_service_stop (ignore a failure when nothing is running), then cells_service_start {"cell_id":"${BRIEFING_CELL_ID}","cmd":"node ${REQUIRED_SERVER_PATH}"}. On success append {"stage":"live","detail":"https://${BRIEFING_CELL_ID}.cells.oncell.ai"}. On failure append {"stage":"service-error","detail":"<why>"} and continue.`,
    `6. Record the iteration in kv "${ITERATIONS_KEY}": build runs REPLACE the array with [{"v":1,...}]; improve runs APPEND with "v" = highest existing v + 1. Entry: {"v":<n>,"summary":"<one user-facing changelog line>","at":"<ISO now>","checkPassed":<true|false>,"snapshotKey":"${BRIEFING_SNAPSHOT_KEY}"} — omit "snapshotKey" when the briefing's snapshot key is empty.`,
    `7. Read kv "${AUTO_KEY}". If its value is exactly "on": call schedule {"note":"improve","in":"${AUTO_IMPROVE_WAKE_IN}"}, set kv "${NEXT_WAKE_KEY}" to the returned wake_at, and append {"stage":"scheduled","detail":"<the wake_at>"}. Otherwise set "${NEXT_WAKE_KEY}" to "".`,
    '8. Append {"stage":"done","detail":"<the changelog line>"}.',
    '',
    `If anything unrecoverable goes wrong at any point, append {"stage":"error","detail":"<what failed>"} to "${PROGRESS_KEY}" and stop.`
  ].join('\n')
}

/** The deploy manifest — exactly the identity/capabilities/skills wire shape. */
export function buildBuilderManifest(ideaName: string, ideaText: string): AgentManifest {
  return {
    identity: {
      instructions: builderIdentityInstructions(ideaName, ideaText),
      model: DEFAULT_BUILDER_MODEL,
      budgets: { perDayCents: BUILDER_BUDGET_PER_DAY_CENTS }
    },
    capabilities: [...BUILDER_CAPABILITIES],
    skills: [
      {
        name: IMPROVE_SKILL_NAME,
        description: IMPROVE_SKILL_DESCRIPTION,
        instructions: improveSkillInstructions(),
        tools: ['cells', 'schedule']
      }
    ]
  }
}
