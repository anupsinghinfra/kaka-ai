import type { OnCellClient } from '@platform/oncell'
import { describe, expect, test, vi } from 'vitest'
import { createRunFeedPoller, toActivityEvent } from '@/lib/builder-agent/feed'

/**
 * Run-feed poller unit tests: run discovery (matching only OUR run,
 * tolerating spin-up 404s), cursor paging, the done latch, and the
 * activity-event mapping.
 */

const NOW = Date.now()

function client(overrides: Partial<Record<'getLatestAgentRun' | 'getAgentRunFeed', unknown>>) {
  return {
    getLatestAgentRun: vi.fn(),
    getAgentRunFeed: vi.fn(),
    ...overrides
  } as unknown as OnCellClient & {
    getLatestAgentRun: ReturnType<typeof vi.fn>
    getAgentRunFeed: ReturnType<typeof vi.fn>
  }
}

const ENTRY = {
  idx: 0,
  ts: '2026-08-01T02:00:01.000Z',
  op: 'cells_write_file',
  summary: 'cells_write_file src/server.js'
}

describe('toActivityEvent', () => {
  test('maps a feed entry onto the activity stream event', () => {
    expect(
      toActivityEvent({ ...ENTRY, cost: 0.12, durationMs: 2100 })
    ).toEqual({
      stage: 'activity',
      op: 'cells_write_file',
      summary: 'cells_write_file src/server.js',
      ts: '2026-08-01T02:00:01.000Z',
      cost: 0.12,
      durationMs: 2100
    })
  })

  test('omits cost and durationMs when the entry has none', () => {
    const event = toActivityEvent(ENTRY)
    expect('cost' in event).toBe(false)
    expect('durationMs' in event).toBe(false)
  })
})

describe('createRunFeedPoller', () => {
  test('tolerates 404s while the run spins up, then attaches and pages', async () => {
    // Arrange
    const oncell = client({})
    oncell.getLatestAgentRun
      .mockRejectedValueOnce(new Error('404 no runs yet'))
      .mockResolvedValue({ runId: 'run-9', startedAt: new Date(NOW).toISOString(), active: true })
    oncell.getAgentRunFeed
      .mockResolvedValueOnce({ entries: [ENTRY], next: 1, done: false })
      .mockResolvedValueOnce({ entries: [{ ...ENTRY, idx: 1 }], next: 2, done: false })
    const poller = createRunFeedPoller(oncell, 'builder-acme', NOW)

    // Act + Assert — first poll: not found yet, no feed call.
    expect(await poller.poll()).toEqual([])
    expect(oncell.getAgentRunFeed).not.toHaveBeenCalled()

    // Second and third polls: attached, cursor advances.
    expect(await poller.poll()).toEqual([ENTRY])
    expect(await poller.poll()).toEqual([{ ...ENTRY, idx: 1 }])
    expect(oncell.getAgentRunFeed).toHaveBeenNthCalledWith(1, 'builder-acme', 'run-9', 0)
    expect(oncell.getAgentRunFeed).toHaveBeenNthCalledWith(2, 'builder-acme', 'run-9', 1)
    expect(poller.relayedCount()).toBe(2)
  })

  test('ignores a stale previous run and never replays its feed', async () => {
    // Arrange — runs/latest still shows the PREVIOUS run (started long ago).
    const oncell = client({})
    oncell.getLatestAgentRun.mockResolvedValue({
      runId: 'run-old',
      startedAt: new Date(NOW - 10 * 60_000).toISOString(),
      active: false
    })
    const poller = createRunFeedPoller(oncell, 'builder-acme', NOW)

    // Act + Assert
    expect(await poller.poll()).toEqual([])
    expect(await poller.poll()).toEqual([])
    expect(oncell.getAgentRunFeed).not.toHaveBeenCalled()
  })

  test('falls back to the active flag when startedAt is unparseable', async () => {
    // Arrange
    const oncell = client({})
    oncell.getLatestAgentRun.mockResolvedValue({ runId: 'run-9', startedAt: 'not-a-date', active: true })
    oncell.getAgentRunFeed.mockResolvedValue({ entries: [ENTRY], next: 1, done: false })
    const poller = createRunFeedPoller(oncell, 'builder-acme', NOW)

    // Act + Assert
    expect(await poller.poll()).toEqual([ENTRY])
  })

  test('latches done and stops calling the API afterwards', async () => {
    // Arrange
    const oncell = client({})
    oncell.getLatestAgentRun.mockResolvedValue({
      runId: 'run-9',
      startedAt: new Date(NOW).toISOString(),
      active: true
    })
    oncell.getAgentRunFeed.mockResolvedValue({ entries: [ENTRY], next: 1, done: true })
    const poller = createRunFeedPoller(oncell, 'builder-acme', NOW)

    // Act
    const first = await poller.poll()
    const second = await poller.poll()

    // Assert
    expect(first).toEqual([ENTRY])
    expect(poller.isDone()).toBe(true)
    expect(second).toEqual([])
    expect(oncell.getAgentRunFeed).toHaveBeenCalledTimes(1)
  })

  test('returns [] on a feed page failure and retries on the next poll', async () => {
    // Arrange
    const oncell = client({})
    oncell.getLatestAgentRun.mockResolvedValue({
      runId: 'run-9',
      startedAt: new Date(NOW).toISOString(),
      active: true
    })
    oncell.getAgentRunFeed
      .mockRejectedValueOnce(new Error('502 bad gateway'))
      .mockResolvedValueOnce({ entries: [ENTRY], next: 1, done: false })
    const poller = createRunFeedPoller(oncell, 'builder-acme', NOW)

    // Act + Assert
    expect(await poller.poll()).toEqual([])
    expect(await poller.poll()).toEqual([ENTRY])
    // The failed page did not advance the cursor.
    expect(oncell.getAgentRunFeed).toHaveBeenLastCalledWith('builder-acme', 'run-9', 0)
  })
})
