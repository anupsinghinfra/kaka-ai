import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The glass-box feed: during an agent run the orchestrator polls BOTH the
 * agent's kv progress and OnCell's runtime run feed, interleaving
 * {stage:"activity"} events with the kv milestones. Covers: interleaving
 * order, feed-done-without-kv-done finalization, the improvised "shipped"
 * terminal stage, and the app-running guarantee on those paths.
 * Everything is mocked — no live calls.
 */

const mockClient = {
  deployAgent: vi.fn(),
  invokeAgentTask: vi.fn(),
  snapshotCell: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  getService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  getCell: vi.fn(),
  getLatestAgentRun: vi.fn(),
  getAgentRunFeed: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => true,
  resetOnCellClientForTests: () => undefined
}))

import { POST as buildRoute } from '@/app/api/ideas/[name]/build/route'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function request(name: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/build`, { method: 'POST' })
}

interface StreamEvent {
  stage: string
  op?: string
  summary?: string
  ts?: string
  cost?: number
  durationMs?: number
  url?: string
  result?: {
    iteration?: { v: number; summary: string }
    liveUrl?: string
    serviceError?: string
  }
  error?: { code?: string }
}

async function readEvents(response: Response): Promise<StreamEvent[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StreamEvent)
}

function draftIdea(): Idea {
  return {
    name: 'acme',
    cellId: 'dev--v-acme',
    customerId: 'v-acme',
    idea: 'sell anvils online',
    createdAt: '2026-08-01T00:00:00.000Z',
    snapshots: [],
    iterations: []
  }
}

interface FeedPage {
  readonly entries: readonly {
    idx: number
    ts: string
    op: string
    summary: string
    cost?: number
    durationMs?: number
  }[]
  readonly next: number
  readonly done: boolean
}

interface ActivityRunScript {
  /** kv progress per poll (stage lists grow over time; the last repeats). */
  readonly kvTicks: readonly (readonly { stage: string; detail?: string }[])[]
  /** Feed pages per poll (the last repeats). */
  readonly feedPages: readonly FeedPage[]
  readonly iterations?: readonly unknown[]
}

/**
 * Arranges a run whose kv progress and runtime feed advance tick by tick,
 * so interleaving across poll cycles is observable. The service defaults to
 * running (the guarantee has nothing to repair unless a test overrides it).
 */
function arrangeActivityRun(script: ActivityRunScript): {
  feedAfters: () => readonly number[]
} {
  let capturedRun: string | undefined
  let kvCall = 0
  let feedCall = 0
  const feedAfters: number[] = []

  mockClient.deployAgent.mockResolvedValue({ agentName: 'builder-acme', version: 1 })
  mockClient.snapshotCell.mockResolvedValue({ snapshot_key: 'snap-1' })
  mockClient.invokeAgentTask.mockImplementation(
    async (_name: string, _task: string, args: Record<string, unknown>) => {
      capturedRun = args.run as string
      return { status: 'completed' }
    }
  )
  mockClient.getService.mockResolvedValue({ running: true, port: 3000 })
  mockClient.getCell.mockResolvedValue({
    cell_id: 'dev--v-acme',
    status: 'running',
    preview_url: 'https://dev--v-acme.cells.oncell.ai'
  })
  mockClient.stopService.mockResolvedValue(undefined)
  mockClient.startService.mockResolvedValue({ running: true, port: 3000 })
  mockClient.getLatestAgentRun.mockImplementation(async () => ({
    runId: 'oncell-run-1',
    startedAt: new Date().toISOString(),
    active: true
  }))
  mockClient.getAgentRunFeed.mockImplementation(
    async (_name: string, _runId: string, after: number) => {
      feedAfters.push(after)
      const page = script.feedPages[Math.min(feedCall, script.feedPages.length - 1)]
      feedCall += 1
      return page
    }
  )
  mockClient.kvGet.mockImplementation(async (_cellId: string, key: string) => {
    if (key === 'kaka:progress') {
      const steps = script.kvTicks[Math.min(kvCall, script.kvTicks.length - 1)]
      kvCall += 1
      const entries = steps.map((step, index) => ({
        ts: `2026-08-01T02:00:0${index}.000Z`,
        run: capturedRun ?? 'run-unknown',
        stage: step.stage,
        ...(step.detail !== undefined ? { detail: step.detail } : {})
      }))
      return { value: JSON.stringify(entries) }
    }
    if (key === 'kaka:iterations') {
      return { value: JSON.stringify(script.iterations ?? []) }
    }
    return { value: undefined }
  })

  return { feedAfters: () => feedAfters }
}

describe('runtime activity feed during agent runs', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-activity-'))
    process.env.KAKA_HOME = home
    delete process.env.KAKA_BUILDER_MODE
    process.env.KAKA_AGENT_POLL_MS = '5'
    process.env.KAKA_AGENT_RUN_TIMEOUT_MS = '5000'
    process.env.KAKA_AGENT_FEED_TAIL_MS = '30'
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    delete process.env.KAKA_AGENT_POLL_MS
    delete process.env.KAKA_AGENT_RUN_TIMEOUT_MS
    delete process.env.KAKA_AGENT_FEED_TAIL_MS
    rmSync(home, { recursive: true, force: true })
  })

  test('interleaves activity events with kv milestones in poll order', async () => {
    // Arrange — kv and feed advance across three poll ticks.
    addIdea(draftIdea())
    const { feedAfters } = arrangeActivityRun({
      kvTicks: [
        [{ stage: 'generating' }],
        [{ stage: 'generating' }, { stage: 'writing' }],
        [{ stage: 'generating' }, { stage: 'writing' }, { stage: 'done', detail: 'Built it.' }]
      ],
      feedPages: [
        {
          entries: [
            {
              idx: 0,
              ts: '2026-08-01T02:00:00.500Z',
              op: 'cells_write_file',
              summary: 'cells_write_file src/server.js',
              cost: 0.12
            },
            {
              idx: 1,
              ts: '2026-08-01T02:00:00.900Z',
              op: 'cells_write_file',
              summary: 'cells_write_file src/check.js'
            }
          ],
          next: 2,
          done: false
        },
        {
          entries: [
            {
              idx: 2,
              ts: '2026-08-01T02:00:01.400Z',
              op: 'cells_exec',
              summary: 'cells_exec node src/check.js',
              cost: 0.05,
              durationMs: 2100
            }
          ],
          next: 3,
          done: false
        },
        { entries: [], next: 3, done: false }
      ],
      iterations: [
        { v: 1, summary: 'Built it.', at: '2026-08-01T02:00:02.000Z', checkPassed: true }
      ]
    })

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — activity rides between the kv milestones, in poll order.
    // The trailing live event is kaka's guarantee reporting the running
    // app's real URL (the agent never wrote a live kv entry).
    expect(events.map((event) => event.stage)).toEqual([
      'preparing',
      'snapshotting',
      'generating',
      'activity',
      'activity',
      'writing',
      'activity',
      'live',
      'done'
    ])
    const activities = events.filter((event) => event.stage === 'activity')
    expect(activities[0]).toMatchObject({
      op: 'cells_write_file',
      summary: 'cells_write_file src/server.js',
      ts: '2026-08-01T02:00:00.500Z',
      cost: 0.12
    })
    expect(activities[2]).toMatchObject({
      op: 'cells_exec',
      cost: 0.05,
      durationMs: 2100
    })
    // Entries without cost/duration omit the fields entirely.
    expect('cost' in (activities[1] ?? {})).toBe(false)
    // The feed cursor advanced with each page (the third tick's kv done
    // finalizes the run before another feed poll happens).
    expect(feedAfters()).toEqual([0, 2])
  })

  test('feed done without kv done: short tail, then finalize from cell state', async () => {
    // Arrange — the agent wrote ONE kv entry and went silent; the runtime
    // feed saw the whole loop and reports it terminated.
    addIdea(draftIdea())
    arrangeActivityRun({
      kvTicks: [[{ stage: 'generating' }]],
      feedPages: [
        {
          entries: [
            {
              idx: 0,
              ts: '2026-08-01T02:00:01.000Z',
              op: 'cells_write_file',
              summary: 'cells_write_file src/server.js'
            },
            { idx: 1, ts: '2026-08-01T02:00:02.000Z', op: 'run_end', summary: 'loop terminated (completed)' }
          ],
          next: 2,
          done: true
        }
      ],
      iterations: [
        { v: 1, summary: 'Built the anvil shop.', at: '2026-08-01T02:00:02.000Z', checkPassed: true }
      ]
    })
    // The model never started the service — kaka's guarantee repairs it.
    mockClient.getService.mockRejectedValue(
      new OnCellApiError({ status: 503, code: 'NO_APP_RUNNING', message: 'no app running' })
    )
    mockClient.stopService.mockRejectedValue(
      new OnCellApiError({ status: 503, code: 'NO_APP_RUNNING', message: 'no app running' })
    )

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — no timeout: the run ended, so kaka reflected reality.
    const stages = events.map((event) => event.stage)
    expect(stages).not.toContain('error')
    expect(stages.filter((stage) => stage === 'activity')).toHaveLength(2)
    expect(stages.indexOf('live')).toBe(stages.indexOf('done') - 1)
    expect(mockClient.startService).toHaveBeenCalledWith('dev--v-acme', {
      cmd: 'node src/server.js'
    })
    const done = events.at(-1)
    expect(done?.stage).toBe('done')
    expect(done?.result?.iteration).toMatchObject({ v: 1, summary: 'Built the anvil shop.' })
    expect(done?.result?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(getIdea('acme')?.iterations.map((iteration) => iteration.v)).toEqual([1])
    expect(getIdea('acme')?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
  })

  test('the improvised "shipped" stage is terminal: relayed verbatim, then finalized like done', async () => {
    // Arrange — the model wrote "shipped" instead of the protocol's "done".
    addIdea(draftIdea())
    arrangeActivityRun({
      kvTicks: [
        [{ stage: 'generating' }],
        [{ stage: 'generating' }, { stage: 'shipped', detail: 'Shipped the anvil shop.' }]
      ],
      feedPages: [{ entries: [], next: 0, done: false }],
      iterations: [
        { v: 1, summary: 'Shipped the anvil shop.', at: '2026-08-01T02:00:02.000Z', checkPassed: true }
      ]
    })

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — shipped shows up as a milestone, the run finalizes as done
    // (service already running, so live reflects the real URL).
    const stages = events.map((event) => event.stage)
    expect(stages).toContain('shipped')
    expect(stages.indexOf('shipped')).toBeLessThan(stages.indexOf('done'))
    expect(stages).not.toContain('error')
    const done = events.at(-1)
    expect(done?.stage).toBe('done')
    expect(done?.result?.iteration).toMatchObject({ v: 1, summary: 'Shipped the anvil shop.' })
    expect(done?.result?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(getIdea('acme')?.iterations.map((iteration) => iteration.v)).toEqual([1])
  })
})
