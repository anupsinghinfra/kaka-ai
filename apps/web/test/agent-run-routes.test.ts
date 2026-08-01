import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Agent-mode build/improve routes: the Builder agent runs on OnCell; kaka
 * deploys it, snapshots the cell, fires the task, and relays the agent's
 * in-cell progress (kaka:progress) as NDJSON stage events. Everything is
 * mocked — no live OnCell or Anthropic calls.
 */

const mockClient = {
  deployAgent: vi.fn(),
  invokeAgentTask: vi.fn(),
  snapshotCell: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => true,
  resetOnCellClientForTests: () => undefined
}))

import { POST as buildRoute } from '@/app/api/ideas/[name]/build/route'
import { POST as improveRoute } from '@/app/api/ideas/[name]/improve/route'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function request(name: string, endpoint: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/${endpoint}`, { method: 'POST' })
}

interface StreamEvent {
  stage: string
  path?: string
  url?: string
  wakeAt?: string
  result?: {
    iteration?: { v: number; summary: string; checkPassed: boolean; snapshotKey?: string }
    check?: { exit_code: number; stdout: string }
    liveUrl?: string
    serviceError?: string
  }
  error?: { code?: string; message?: string; remediation?: string }
}

async function readEvents(response: Response): Promise<StreamEvent[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StreamEvent)
}

function draftIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    name: 'acme',
    cellId: 'dev--v-acme',
    customerId: 'v-acme',
    idea: 'sell anvils online',
    createdAt: '2026-08-01T00:00:00.000Z',
    snapshots: [],
    iterations: [],
    ...overrides
  }
}

function builtIdea(): Idea {
  return draftIdea({
    builtAt: '2026-08-01T01:00:00.000Z',
    iterations: [
      { v: 1, summary: 'Built the anvil shop.', at: '2026-08-01T01:00:00.000Z', checkPassed: true }
    ]
  })
}

interface AgentRunScript {
  /** Progress stages (with details) the agent "writes" after being invoked. */
  readonly progress: readonly { stage: string; detail?: string }[]
  /** The kaka:iterations value after the run. */
  readonly iterations?: readonly unknown[]
}

/**
 * Arranges the mocked cell: invoke captures the run token, and kv reads
 * replay the scripted progress (tagged with that token) plus a stale entry
 * from an older run that must be ignored.
 */
function arrangeAgentRun(script: AgentRunScript): { invokedArgs: () => Record<string, unknown> } {
  let capturedArgs: Record<string, unknown> = {}
  mockClient.deployAgent.mockResolvedValue({ agentName: 'builder-acme', version: 1 })
  mockClient.snapshotCell.mockResolvedValue({ snapshot_key: 'snap-1' })
  mockClient.invokeAgentTask.mockImplementation(
    async (_name: string, _task: string, args: Record<string, unknown>) => {
      capturedArgs = args
      return { status: 'completed' }
    }
  )
  mockClient.kvGet.mockImplementation(async (_cellId: string, key: string) => {
    if (key === 'kaka:progress') {
      const run = capturedArgs.run as string | undefined
      const stale = { ts: '2026-08-01T00:00:00.000Z', run: 'run-old', stage: 'done' }
      const entries =
        run === undefined
          ? [stale]
          : [
              stale,
              ...script.progress.map((step, index) => ({
                ts: `2026-08-01T02:00:0${index}.000Z`,
                run,
                stage: step.stage,
                ...(step.detail !== undefined ? { detail: step.detail } : {})
              }))
            ]
      return { value: JSON.stringify(entries) }
    }
    if (key === 'kaka:iterations') {
      return { value: JSON.stringify(script.iterations ?? []) }
    }
    return { value: undefined }
  })
  return { invokedArgs: () => capturedArgs }
}

describe('agent-mode build and improve routes', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-agent-run-'))
    process.env.KAKA_HOME = home
    delete process.env.KAKA_BUILDER_MODE // default: agent mode
    process.env.KAKA_AGENT_POLL_MS = '5'
    process.env.KAKA_AGENT_RUN_TIMEOUT_MS = '5000'
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    delete process.env.KAKA_AGENT_POLL_MS
    delete process.env.KAKA_AGENT_RUN_TIMEOUT_MS
    delete process.env.KAKA_AGENT_INVOKE_GRACE_MS
    rmSync(home, { recursive: true, force: true })
  })

  test('build: deploys, snapshots, fires the task, and relays progress to done', async () => {
    // Arrange
    addIdea(draftIdea())
    const { invokedArgs } = arrangeAgentRun({
      progress: [
        { stage: 'generating' },
        { stage: 'writing' },
        { stage: 'file', detail: 'src/server.js' },
        { stage: 'verifying' },
        { stage: 'checked', detail: '{"exitCode":0,"output":"CHECK_OK"}' },
        { stage: 'starting' },
        { stage: 'live', detail: 'https://dev--v-acme.cells.oncell.ai' },
        { stage: 'done', detail: 'Built the anvil shop.' }
      ],
      iterations: [
        {
          v: 1,
          summary: 'Built the anvil shop.',
          at: '2026-08-01T02:00:00.000Z',
          checkPassed: true,
          snapshotKey: 'snap-1'
        }
      ]
    })

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert — orchestrator stages then the agent's relayed narrative.
    expect(response.status).toBe(200)
    expect(events.map((event) => event.stage)).toEqual([
      'preparing',
      'snapshotting',
      'generating',
      'writing',
      'file',
      'verifying',
      'starting',
      'live',
      'done'
    ])
    expect(events.find((event) => event.stage === 'file')?.path).toBe('src/server.js')
    expect(events.find((event) => event.stage === 'live')?.url).toBe(
      'https://dev--v-acme.cells.oncell.ai'
    )
    const done = events.at(-1)
    expect(done?.result?.iteration).toMatchObject({ v: 1, checkPassed: true, snapshotKey: 'snap-1' })
    expect(done?.result?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(done?.result?.check).toMatchObject({ exit_code: 0 })

    // The Builder was (re)deployed with the current idea text and invoked
    // with the cell, a fresh run token, and the pre-run snapshot key.
    expect(mockClient.deployAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'builder-acme',
        source: expect.stringContaining('sell anvils online'),
        manifest: expect.objectContaining({ capabilities: ['memory', 'cells', 'schedule'] })
      })
    )
    expect(mockClient.invokeAgentTask).toHaveBeenCalledWith(
      'builder-acme',
      'build',
      expect.objectContaining({ cell_id: 'dev--v-acme', snapshot_key: 'snap-1' })
    )
    expect(String(invokedArgs().run)).toMatch(/^run-/)
    // Snapshot precedes the invocation — it is the rollback point.
    expect(mockClient.snapshotCell.mock.invocationCallOrder[0]).toBeLessThan(
      mockClient.invokeAgentTask.mock.invocationCallOrder[0] as number
    )

    // Registry adopted the cell's record.
    const idea = getIdea('acme')
    expect(idea?.iterations.map((iteration) => iteration.v)).toEqual([1])
    expect(idea?.builtAt).toBeDefined()
    expect(idea?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(idea?.lastCheck).toEqual({ exitCode: 0, output: 'CHECK_OK' })
  })

  test('improve: fires the improve task and records v2 from the cell', async () => {
    // Arrange
    addIdea(builtIdea())
    arrangeAgentRun({
      progress: [
        { stage: 'reading' },
        { stage: 'generating' },
        { stage: 'writing' },
        { stage: 'file', detail: 'src/server.js' },
        { stage: 'verifying' },
        { stage: 'checked', detail: '{"exitCode":0,"output":"CHECK_OK"}' },
        { stage: 'starting' },
        { stage: 'live', detail: 'https://dev--v-acme.cells.oncell.ai' },
        { stage: 'scheduled', detail: '2026-08-01T02:30:00.000Z' },
        { stage: 'done', detail: 'Added search.' }
      ],
      iterations: [
        { v: 1, summary: 'Built the anvil shop.', at: '2026-08-01T01:00:00.000Z', checkPassed: true },
        {
          v: 2,
          summary: 'Added search.',
          at: '2026-08-01T02:00:00.000Z',
          checkPassed: true,
          snapshotKey: 'snap-1'
        }
      ]
    })

    // Act
    const response = await improveRoute(request('acme', 'improve'), params('acme'))
    const events = await readEvents(response)

    // Assert
    expect(events.map((event) => event.stage)).toContain('scheduled')
    expect(events.find((event) => event.stage === 'scheduled')?.wakeAt).toBe(
      '2026-08-01T02:30:00.000Z'
    )
    expect(events.at(-1)?.result?.iteration).toMatchObject({ v: 2, summary: 'Added search.' })
    expect(mockClient.invokeAgentTask).toHaveBeenCalledWith(
      'builder-acme',
      'improve',
      expect.objectContaining({ cell_id: 'dev--v-acme' })
    )
    expect(getIdea('acme')?.iterations.map((iteration) => iteration.v)).toEqual([1, 2])
  })

  test('a service-error run still completes with the failure surfaced', async () => {
    // Arrange
    addIdea(draftIdea())
    arrangeAgentRun({
      progress: [
        { stage: 'generating' },
        { stage: 'checked', detail: '{"exitCode":0,"output":"CHECK_OK"}' },
        { stage: 'service-error', detail: 'the app crashed on boot' },
        { stage: 'done', detail: 'Built it, but it is not serving.' }
      ],
      iterations: [
        { v: 1, summary: 'Built it.', at: '2026-08-01T02:00:00.000Z', checkPassed: true }
      ]
    })

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert — done (not error), with serviceError and no live URL.
    const done = events.at(-1)
    expect(done?.stage).toBe('done')
    expect(done?.result?.serviceError).toBe('the app crashed on boot')
    expect(done?.result?.liveUrl).toBeUndefined()
    expect(getIdea('acme')?.serviceError).toBe('the app crashed on boot')
    expect(getIdea('acme')?.liveUrl).toBeUndefined()
  })

  test('an agent-reported error ends the stream with AGENT_RUN_FAILED', async () => {
    // Arrange
    addIdea(draftIdea())
    arrangeAgentRun({
      progress: [{ stage: 'generating' }, { stage: 'error', detail: 'budget exhausted' }]
    })

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert
    const last = events.at(-1)
    expect(last?.stage).toBe('error')
    expect(last?.error?.code).toBe('AGENT_RUN_FAILED')
    expect(last?.error?.message).toContain('budget exhausted')
  })

  test('a failed deploy surfaces AGENT_UNAVAILABLE — no silent local fallback', async () => {
    // Arrange
    addIdea(draftIdea())
    mockClient.deployAgent.mockRejectedValue(
      new OnCellApiError({ status: 503, message: 'agents not enabled' })
    )

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert — clear error, and neither snapshot nor invoke ever happened.
    expect(events.map((event) => event.stage)).toEqual(['preparing', 'error'])
    expect(events.at(-1)?.error?.code).toBe('AGENT_UNAVAILABLE')
    expect(events.at(-1)?.error?.remediation).toContain('KAKA_BUILDER_MODE=local')
    expect(mockClient.snapshotCell).not.toHaveBeenCalled()
    expect(mockClient.invokeAgentTask).not.toHaveBeenCalled()
  })

  test('a failed invocation surfaces AGENT_UNAVAILABLE', async () => {
    // Arrange — grace window elapsed with no progress: invoke failures are
    // otherwise tolerated (the run outlives the edge's idle timeout).
    process.env.KAKA_AGENT_INVOKE_GRACE_MS = '10'
    addIdea(draftIdea())
    mockClient.deployAgent.mockResolvedValue({ agentName: 'builder-acme', version: 1 })
    mockClient.snapshotCell.mockResolvedValue({ snapshot_key: 'snap-1' })
    mockClient.invokeAgentTask.mockRejectedValue(
      new OnCellApiError({ status: 404, code: 'AGENT_NOT_FOUND', message: 'no such agent' })
    )
    mockClient.kvGet.mockResolvedValue({ value: '[]' })

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert
    expect(events.at(-1)?.error?.code).toBe('AGENT_UNAVAILABLE')
    expect(events.at(-1)?.error?.message).toContain('no such agent')
  })

  test('a silent agent times out with AGENT_RUN_TIMEOUT', async () => {
    // Arrange — the agent never writes any progress for this run.
    process.env.KAKA_AGENT_RUN_TIMEOUT_MS = '40'
    addIdea(draftIdea())
    mockClient.deployAgent.mockResolvedValue({ agentName: 'builder-acme', version: 1 })
    mockClient.snapshotCell.mockResolvedValue({ snapshot_key: 'snap-1' })
    mockClient.invokeAgentTask.mockResolvedValue({ status: 'completed' })
    mockClient.kvGet.mockResolvedValue({ value: '[]' })

    // Act
    const response = await buildRoute(request('acme', 'build'), params('acme'))
    const events = await readEvents(response)

    // Assert
    expect(events.at(-1)?.stage).toBe('error')
    expect(events.at(-1)?.error?.code).toBe('AGENT_RUN_TIMEOUT')
  })

  test('improve still requires a built v1 in agent mode', async () => {
    // Arrange
    addIdea(draftIdea())

    // Act
    const response = await improveRoute(request('acme', 'improve'), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('NOT_BUILT_YET')
    expect(mockClient.deployAgent).not.toHaveBeenCalled()
  })
})
