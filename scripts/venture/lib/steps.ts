/**
 * Step runner for the golden path: prints progress, records timings, and
 * renders the final report. Assertion failures use GoldenPathAssertionError
 * so they are distinguishable from transport errors.
 */

/** Thrown when a golden-path assertion fails. */
export class GoldenPathAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoldenPathAssertionError'
  }
}

/** Asserts a golden-path invariant. */
export function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new GoldenPathAssertionError(message)
  }
}

/** Outcome of one recorded step. */
export interface StepResult {
  readonly name: string
  readonly durationMs: number
  readonly ok: boolean
  readonly error?: string
}

/** Runs named steps, printing progress and collecting results. */
export interface StepRunner {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>
  results(): readonly StepResult[]
}

const SECOND_MS = 1000

/** Formats a duration as "842ms" below 1s, otherwise "3.2s". */
export function formatDuration(ms: number): string {
  if (ms < SECOND_MS) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / SECOND_MS).toFixed(1)}s`
}

/** Creates a StepRunner. `now` is injectable for tests. */
export function createStepRunner(
  print: (line: string) => void,
  now: () => number = Date.now
): StepRunner {
  const collected: StepResult[] = []

  async function run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stepNumber = collected.length + 1
    print(`[${stepNumber}] ${name} ...`)
    const startedAt = now()
    try {
      const value = await fn()
      const durationMs = now() - startedAt
      collected.push({ name, durationMs, ok: true })
      print(`[${stepNumber}] ${name} — ok (${formatDuration(durationMs)})`)
      return value
    } catch (error: unknown) {
      const durationMs = now() - startedAt
      const message = error instanceof Error ? error.message : String(error)
      collected.push({ name, durationMs, ok: false, error: message })
      print(`[${stepNumber}] ${name} — FAILED (${formatDuration(durationMs)}): ${message}`)
      throw error
    }
  }

  return { run, results: () => [...collected] }
}

/** Renders the final step-by-step report with totals. */
export function formatReport(results: readonly StepResult[]): string {
  const lines = results.map((result, index) => {
    const status = result.ok ? 'PASS' : 'FAIL'
    return `  ${index + 1}. [${status}] ${result.name} (${formatDuration(result.durationMs)})`
  })
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0)
  const failed = results.filter((result) => !result.ok).length
  const summary =
    failed === 0
      ? `  Total: ${formatDuration(totalMs)} — all ${results.length} steps passed`
      : `  Total: ${formatDuration(totalMs)} — ${failed} of ${results.length} steps FAILED`
  return ['Golden-path report:', ...lines, summary].join('\n')
}
