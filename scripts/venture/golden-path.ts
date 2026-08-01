/**
 * Golden-path heartbeat (EXECUTION.md M1) against REAL OnCell production,
 * via @platform/oncell.
 *
 * Proves the branch triple across snapshot/fork:
 *   code  — the app's check script runs green in the fork,
 *   files — a data file written pre-fork reads back in the fork,
 *   state — a KV entry set pre-fork is present in the fork.
 *
 * NOTE: preview URL serving is not yet wired host-side (known OnCell gap —
 * an OnCell-side gap). This run proves the branch triple, NOT HTTP serving;
 * the serve-from-cell leg joins the canary when OnCell closes that gap.
 *
 * Usage:  pnpm golden-path [-- <suffix>] [--keep]
 *   Creates cells gp-{suffix} and gp-{suffix}-branch (suffix defaults to
 *   "main"); --keep skips cleanup. Requires ONCELL_API_KEY (repo-root .env
 *   is loaded as a fallback). Exits non-zero on any assertion failure.
 */

import { resolve } from 'node:path'
import {
  createOnCellClient,
  type ExecResult,
  type OnCellClient
} from '@platform/oncell'
import { parseGoldenPathArgs } from './lib/args'
import { loadEnvFile } from './lib/env'
import { extractFileContent, extractKvValue } from './lib/extract'
import { createStepRunner, ensure, formatReport } from './lib/steps'

const EXEC_TIMEOUT_MS = 60_000
const CHECK_CMD = 'node src/check.js'
const NOTES_PATH = 'data/notes.txt'
const NOTES_CONTENT = 'golden-path notes v1\n'
const VERSION_KEY = 'version'
const VERSION_VALUE = '1'

/** The tiny real app written into the venture cell. */
const APP_PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'gp-app',
    version: '1.0.0',
    private: true,
    scripts: { check: 'node src/check.js' }
  },
  null,
  2
)}\n`

/** src/app.js — a pure function plus a version marker the check prints. */
function appSource(version: number): string {
  return [
    "'use strict'",
    `const APP_VERSION = ${version}`,
    'function add(a, b) {',
    '  return a + b',
    '}',
    'module.exports = { APP_VERSION, add }',
    ''
  ].join('\n')
}

/** src/check.js — runnable proof the app works; prints "APP_OK v{n}". */
const CHECK_SOURCE = [
  "'use strict'",
  "const { APP_VERSION, add } = require('./app')",
  'if (add(2, 3) !== 5) {',
  "  console.error('add(2, 3) !== 5')",
  '  process.exit(1)',
  '}',
  'console.log(`APP_OK v${APP_VERSION}`)',
  ''
].join('\n')

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Runs the in-cell check script and asserts its expected marker line. */
async function runCheck(
  client: OnCellClient,
  cellId: string,
  expectedMarker: string,
  idempotencyKey: string
): Promise<ExecResult> {
  const result = await client.exec(cellId, {
    cmd: CHECK_CMD,
    timeoutMs: EXEC_TIMEOUT_MS,
    idempotencyKey,
    expectSuccess: true
  })
  ensure(
    result.stdout.includes(expectedMarker),
    `expected check stdout to include "${expectedMarker}", got: ${result.stdout.trim()}`
  )
  return result
}

/** Writes the app files (package.json + src) at the given app version. */
async function writeApp(client: OnCellClient, cellId: string, version: number): Promise<void> {
  await client.writeFile(cellId, 'package.json', APP_PACKAGE_JSON)
  await client.writeFile(cellId, 'src/app.js', appSource(version))
  await client.writeFile(cellId, 'src/check.js', CHECK_SOURCE)
}

/** Best-effort cell deletion during cleanup — failures warn, never throw. */
async function deleteQuietly(client: OnCellClient, cellId: string | undefined): Promise<void> {
  if (cellId === undefined) {
    return
  }
  try {
    await client.deleteCell(cellId)
    print(`  cleaned up ${cellId}`)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    print(`  WARNING: failed to delete ${cellId}: ${message}`)
  }
}

async function main(): Promise<number> {
  // Fallback env source; real env vars always win. Never logs values.
  loadEnvFile(resolve(__dirname, '../../.env'))
  const args = parseGoldenPathArgs(process.argv.slice(2))
  const client = createOnCellClient()
  const runner = createStepRunner(print)
  const runId = Date.now().toString(36)

  const baseCustomer = `gp-${args.suffix}`
  const forkCustomer = `gp-${args.suffix}-branch`
  let baseCellId: string | undefined
  let forkCellId: string | undefined
  let exitCode = 0

  print(`Golden path: base=${baseCustomer} fork=${forkCustomer} run=${runId}`)

  try {
    await runner.run(`create venture cell (${baseCustomer})`, async () => {
      const cell = await client.createCell({ customerId: baseCustomer })
      baseCellId = cell.cell_id
      print(`    cell_id=${cell.cell_id} status=${cell.status} preview_url=${cell.preview_url ?? 'n/a'}`)
    })

    await runner.run('write app and prove it runs (check v1)', async () => {
      ensure(baseCellId !== undefined, 'base cell id missing')
      await writeApp(client, baseCellId, 1)
      const result = await runCheck(client, baseCellId, 'APP_OK v1', `gp-${runId}-base-check-v1`)
      print(`    check stdout: ${result.stdout.trim()} (${result.duration_ms}ms in cell)`)
    })

    await runner.run('write venture state (kv version + data file)', async () => {
      ensure(baseCellId !== undefined, 'base cell id missing')
      await client.kvSet(baseCellId, VERSION_KEY, VERSION_VALUE)
      await client.writeFile(baseCellId, NOTES_PATH, NOTES_CONTENT)
    })

    const snapshotKey = await runner.run('snapshot base cell', async () => {
      ensure(baseCellId !== undefined, 'base cell id missing')
      const snapshot = await client.snapshotCell(baseCellId)
      print(`    snapshot_key=${snapshot.snapshot_key} size_bytes=${snapshot.size_bytes ?? 'n/a'}`)
      return snapshot.snapshot_key
    })
    ensure(snapshotKey.length > 0, 'snapshot_key must be non-empty')

    await runner.run(`fork -> ${forkCustomer} and prove the branch triple`, async () => {
      ensure(baseCellId !== undefined, 'base cell id missing')
      const fork = await client.forkCell(baseCellId, { customerId: forkCustomer })
      forkCellId = fork.cell_id
      print(`    fork cell_id=${fork.cell_id} forked_from=${fork.forked_from ?? 'n/a'}`)

      // Code: the check script runs green in the fork.
      await runCheck(client, forkCellId, 'APP_OK v1', `gp-${runId}-fork-check-v1`)
      // Files: the pre-fork data file reads back in the fork.
      const readResult = await client.readFile(forkCellId, NOTES_PATH)
      const content = extractFileContent(readResult)
      ensure(
        content !== undefined && content.includes('golden-path notes v1'),
        `fork ${NOTES_PATH} mismatch: ${JSON.stringify(readResult)}`
      )
      // State: the pre-fork KV entry is present in the fork.
      const kvResult = await client.kvGet(forkCellId, VERSION_KEY)
      const version = extractKvValue(kvResult)
      ensure(
        String(version) === VERSION_VALUE,
        `fork kv ${VERSION_KEY} mismatch: ${JSON.stringify(kvResult)}`
      )
      print('    branch triple verified: code + files + state')
    })

    await runner.run('change code in the fork and re-verify (check v2)', async () => {
      ensure(forkCellId !== undefined, 'fork cell id missing')
      await client.writeFile(forkCellId, 'src/app.js', appSource(2))
      const result = await runCheck(client, forkCellId, 'APP_OK v2', `gp-${runId}-fork-check-v2`)
      print(`    check stdout: ${result.stdout.trim()}`)
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    print(`\nGolden path FAILED: ${message}`)
    exitCode = 1
  } finally {
    if (args.keep) {
      print(`--keep set: leaving cells ${baseCellId ?? '(none)'} and ${forkCellId ?? '(none)'}`)
    } else {
      print('Cleanup:')
      await deleteQuietly(client, forkCellId)
      await deleteQuietly(client, baseCellId)
    }
    print('')
    print(formatReport(runner.results()))
  }

  return exitCode
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    print(`Golden path crashed: ${message}`)
    process.exitCode = 1
  })
