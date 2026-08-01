import { describe, expect, test } from 'vitest'
import {
  parseCellIterations,
  parseCheckedDetail,
  parseProgressEntries,
  toStreamEvent,
  type ProgressEntry
} from '@/lib/builder-agent/progress'

/**
 * Progress/iteration kv parsing (model-written, so tolerance matters) and
 * the mapping onto the browser's stage-event schema.
 */

function entry(stage: string, detail?: string): ProgressEntry {
  return {
    ts: '2026-08-01T00:00:00.000Z',
    run: 'run-1',
    stage,
    ...(detail !== undefined ? { detail } : {})
  }
}

describe('parseProgressEntries', () => {
  test('parses a JSON string of entries, skipping invalid ones', () => {
    // Arrange
    const raw = JSON.stringify([
      entry('generating'),
      { ts: '2026-08-01T00:00:01.000Z', stage: 'writing' }, // missing run
      entry('file', 'src/server.js'),
      'garbage'
    ])

    // Act
    const entries = parseProgressEntries(raw)

    // Assert
    expect(entries).toHaveLength(2)
    expect(entries[0]?.stage).toBe('generating')
    expect(entries[1]).toMatchObject({ stage: 'file', detail: 'src/server.js' })
  })

  test('accepts an already-parsed array', () => {
    expect(parseProgressEntries([entry('done')])).toHaveLength(1)
  })

  test('returns [] for missing, non-JSON, or non-array values', () => {
    expect(parseProgressEntries(undefined)).toEqual([])
    expect(parseProgressEntries('not json')).toEqual([])
    expect(parseProgressEntries('{"stage":"done"}')).toEqual([])
    expect(parseProgressEntries(42)).toEqual([])
  })
})

describe('parseCellIterations', () => {
  test('parses valid iterations and skips malformed ones', () => {
    // Arrange
    const raw = JSON.stringify([
      { v: 1, summary: 'Built it.', at: '2026-08-01T00:00:00.000Z', checkPassed: true },
      { v: 'two', summary: 'bad', at: 'x', checkPassed: true },
      {
        v: 2,
        summary: 'Improved it.',
        at: '2026-08-01T01:00:00.000Z',
        checkPassed: false,
        snapshotKey: 'snap-2'
      }
    ])

    // Act
    const iterations = parseCellIterations(raw)

    // Assert
    expect(iterations.map((iteration) => iteration.v)).toEqual([1, 2])
    expect(iterations[1]?.snapshotKey).toBe('snap-2')
  })
})

describe('parseCheckedDetail', () => {
  test('parses the {exitCode, output} JSON payload', () => {
    expect(parseCheckedDetail('{"exitCode":0,"output":"CHECK_OK"}')).toEqual({
      exitCode: 0,
      output: 'CHECK_OK'
    })
  })

  test('returns undefined for malformed detail', () => {
    expect(parseCheckedDetail(undefined)).toBeUndefined()
    expect(parseCheckedDetail('nope')).toBeUndefined()
    expect(parseCheckedDetail('{"exitCode":"zero"}')).toBeUndefined()
  })
})

describe('toStreamEvent', () => {
  test('maps file, live, and scheduled entries with their payloads', () => {
    expect(toStreamEvent(entry('file', 'src/app.js'))).toEqual({
      stage: 'file',
      path: 'src/app.js'
    })
    expect(toStreamEvent(entry('live', 'https://c.cells.oncell.ai'))).toEqual({
      stage: 'live',
      url: 'https://c.cells.oncell.ai'
    })
    expect(toStreamEvent(entry('scheduled', '2026-08-01T02:00:00.000Z'))).toEqual({
      stage: 'scheduled',
      wakeAt: '2026-08-01T02:00:00.000Z'
    })
  })

  test('keeps plain stages and hides internal ones', () => {
    expect(toStreamEvent(entry('generating'))).toEqual({ stage: 'generating' })
    expect(toStreamEvent(entry('checked', '{"exitCode":0,"output":"ok"}'))).toBeUndefined()
    expect(toStreamEvent(entry('service-error', 'boom'))).toBeUndefined()
  })
})
