import {
  createStepRunner,
  ensure,
  formatDuration,
  formatReport,
  GoldenPathAssertionError
} from '../lib/steps'

/** Deterministic clock advancing a fixed amount per call. */
function fakeClock(stepMs: number): () => number {
  let current = 0
  return () => {
    const value = current
    current += stepMs
    return value
  }
}

describe('ensure', () => {
  test('does nothing when the condition holds', () => {
    expect(() => ensure(true, 'never')).not.toThrow()
  })

  test('throws GoldenPathAssertionError with the message when it fails', () => {
    expect(() => ensure(false, 'triple broken')).toThrow(GoldenPathAssertionError)
    expect(() => ensure(false, 'triple broken')).toThrow('triple broken')
  })
})

describe('formatDuration', () => {
  test('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(842)).toBe('842ms')
  })

  test('renders second-scale durations with one decimal', () => {
    expect(formatDuration(3210)).toBe('3.2s')
  })
})

describe('createStepRunner', () => {
  test('records a passing step with its duration and returns the value', async () => {
    // Arrange
    const lines: string[] = []
    const runner = createStepRunner((line) => lines.push(line), fakeClock(100))

    // Act
    const value = await runner.run('create cell', () => Promise.resolve('cell-1'))

    // Assert
    expect(value).toBe('cell-1')
    expect(runner.results()).toEqual([{ name: 'create cell', durationMs: 100, ok: true }])
    expect(lines[1]).toContain('ok (100ms)')
  })

  test('records a failing step and rethrows the original error', async () => {
    // Arrange
    const runner = createStepRunner(() => undefined, fakeClock(50))

    // Act
    const failure = runner.run('fork', () => Promise.reject(new Error('fork exploded')))

    // Assert
    await expect(failure).rejects.toThrow('fork exploded')
    expect(runner.results()).toEqual([
      { name: 'fork', durationMs: 50, ok: false, error: 'fork exploded' }
    ])
  })

  test('numbers steps sequentially in printed output', async () => {
    // Arrange
    const lines: string[] = []
    const runner = createStepRunner((line) => lines.push(line), fakeClock(10))

    // Act
    await runner.run('first', () => Promise.resolve())
    await runner.run('second', () => Promise.resolve())

    // Assert
    expect(lines[0]).toMatch(/^\[1\] first/)
    expect(lines[2]).toMatch(/^\[2\] second/)
  })
})

describe('formatReport', () => {
  test('renders PASS/FAIL lines with a failure summary', () => {
    // Arrange
    const results = [
      { name: 'create', durationMs: 500, ok: true },
      { name: 'fork', durationMs: 1500, ok: false, error: 'boom' }
    ]

    // Act
    const report = formatReport(results)

    // Assert
    expect(report).toContain('1. [PASS] create (500ms)')
    expect(report).toContain('2. [FAIL] fork (1.5s)')
    expect(report).toContain('1 of 2 steps FAILED')
  })

  test('summarizes an all-green run', () => {
    // Arrange
    const results = [{ name: 'create', durationMs: 400, ok: true }]

    // Act
    const report = formatReport(results)

    // Assert
    expect(report).toContain('all 1 steps passed')
  })
})
