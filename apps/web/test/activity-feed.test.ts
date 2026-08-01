import { describe, expect, test } from 'vitest'
import { accumulateCost, activityLineText, formatCostTicker } from '@/components/activity-feed'

/**
 * Pure activity-feed formatting: the monospace op lines and the running
 * cost ticker the panel header shows.
 */

describe('activityLineText', () => {
  test('renders a tool op with its summary', () => {
    expect(
      activityLineText({ op: 'cells_write_file', summary: 'cells_write_file src/server.js' })
    ).toBe('⚙ cells_write_file src/server.js')
  })

  test('prepends the op when the summary does not carry it', () => {
    expect(activityLineText({ op: 'cells_exec', summary: 'node src/check.js' })).toBe(
      '⚙ cells_exec node src/check.js'
    )
  })

  test('appends the duration in seconds when present', () => {
    expect(
      activityLineText({ op: 'cells_exec', summary: 'node src/check.js', durationMs: 2100 })
    ).toBe('⚙ cells_exec node src/check.js (2.1s)')
  })

  test('renders sub-second durations in milliseconds', () => {
    expect(activityLineText({ op: 'cells_kv_get', summary: 'kaka:progress', durationMs: 87 })).toBe(
      '⚙ cells_kv_get kaka:progress (87ms)'
    )
  })

  test('renders step ops as quiet counters', () => {
    expect(activityLineText({ op: 'step', summary: 'step 12' })).toBe('· step 12')
  })

  test('tolerates missing fields', () => {
    expect(activityLineText({ op: 'cells_exec' })).toBe('⚙ cells_exec')
    expect(activityLineText({ summary: 'something happened' })).toBe('⚙ something happened')
  })
})

describe('accumulateCost', () => {
  test('accumulates costs across events, ignoring events without one', () => {
    // Arrange
    const events = [{ cost: 0.15 }, {}, { cost: 0.27 }, { cost: undefined }]

    // Act
    const total = events.reduce((sum, event) => accumulateCost(sum, event.cost), 0)

    // Assert
    expect(total).toBeCloseTo(0.42, 10)
  })

  test('ignores non-finite and non-positive costs', () => {
    expect(accumulateCost(1, Number.NaN)).toBe(1)
    expect(accumulateCost(1, Number.POSITIVE_INFINITY)).toBe(1)
    expect(accumulateCost(1, -0.5)).toBe(1)
  })
})

describe('formatCostTicker', () => {
  test('formats the running total as dollars', () => {
    expect(formatCostTicker(0.42)).toBe('$0.42 so far')
  })

  test('stays hidden until any cost arrives', () => {
    expect(formatCostTicker(0)).toBeUndefined()
  })
})
