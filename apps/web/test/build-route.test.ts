import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Build route tests: mocked @platform/oncell (via getOnCell) and a mocked
 * Anthropic SDK — no live calls. Exercises the full NDJSON build flow
 * including the app-service restart, the live URL payoff, and the
 * non-fatal service failure path.
 */

const mockClient = {
  writeFile: vi.fn(),
  exec: vi.fn(),
  getCell: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => true,
  resetOnCellClientForTests: () => undefined
}))

const { mockFinalMessage } = vi.hoisted(() => ({ mockFinalMessage: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      stream: (): { finalMessage: () => Promise<unknown> } => ({
        finalMessage: mockFinalMessage
      })
    }
  }
}))

import { POST as buildRoute } from '@/app/api/ideas/[name]/build/route'
import { BUILDER_TOOL_NAME } from '@/lib/builder/contract'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function request(name: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/build`, { method: 'POST' })
}

interface StreamEvent {
  stage: string
  files?: number
  path?: string
  url?: string
  result?: {
    iteration: { v: number; checkPassed: boolean }
    liveUrl?: string
    serviceError?: string
  }
  error?: { code?: string; message?: string }
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

function appResponse() {
  return {
    content: [
      {
        type: 'tool_use',
        name: BUILDER_TOOL_NAME,
        input: {
          summary: 'An anvil shop.',
          files: [
            { path: 'src/server.js', content: 'require("node:http")\n' },
            { path: 'src/check.js', content: "console.log('CHECK_OK')\n" }
          ]
        }
      }
    ]
  }
}

function arrangeHealthyBuild(): void {
  mockClient.writeFile.mockResolvedValue({})
  mockClient.exec.mockResolvedValue({
    exit_code: 0,
    stdout: 'CHECK_OK\n',
    stderr: '',
    truncated: false,
    duration_ms: 12,
    replayed: false
  })
  mockClient.stopService.mockResolvedValue(undefined)
  mockClient.startService.mockResolvedValue({ running: true, port: 3000 })
  mockClient.getCell.mockResolvedValue({
    cell_id: 'dev--v-acme',
    status: 'running',
    preview_url: 'https://dev--v-acme.cells.oncell.ai'
  })
  mockFinalMessage.mockResolvedValue(appResponse())
}

describe('POST /api/ideas/[name]/build', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-build-'))
    process.env.KAKA_HOME = home
    // These tests exercise the local (in-process Anthropic) escape hatch.
    process.env.KAKA_BUILDER_MODE = 'local'
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    delete process.env.KAKA_BUILDER_MODE
    rmSync(home, { recursive: true, force: true })
  })

  test('streams the full build, restarts the app, and records the live URL', async () => {
    // Arrange
    addIdea(draftIdea())
    arrangeHealthyBuild()

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — stage narrative including per-file and service events.
    expect(response.status).toBe(200)
    expect(events.map((event) => event.stage)).toEqual([
      'generating',
      'writing',
      'file',
      'file',
      'verifying',
      'starting',
      'live',
      'done'
    ])
    expect(events.filter((event) => event.stage === 'file').map((event) => event.path)).toEqual([
      'src/server.js',
      'src/check.js'
    ])
    expect(events.find((event) => event.stage === 'live')?.url).toBe(
      'https://dev--v-acme.cells.oncell.ai'
    )
    const done = events.at(-1)
    expect(done?.result?.iteration).toMatchObject({ v: 1, checkPassed: true })
    expect(done?.result?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')

    // Service restarted with the contract entry point.
    expect(mockClient.stopService).toHaveBeenCalledWith('dev--v-acme')
    expect(mockClient.startService).toHaveBeenCalledWith('dev--v-acme', {
      cmd: 'node src/server.js'
    })

    // Registry side effects.
    const idea = getIdea('acme')
    expect(idea?.builtAt).toBeDefined()
    expect(idea?.iterations.map((iteration) => iteration.v)).toEqual([1])
    expect(idea?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(idea?.serviceError).toBeUndefined()
  })

  test('tolerates NO_APP_RUNNING from the pre-start stop', async () => {
    // Arrange — first build: nothing to stop yet.
    addIdea(draftIdea())
    arrangeHealthyBuild()
    mockClient.stopService.mockRejectedValue(
      new OnCellApiError({ status: 503, code: 'NO_APP_RUNNING', message: 'no app running' })
    )

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — still goes live.
    expect(events.find((event) => event.stage === 'live')?.url).toBe(
      'https://dev--v-acme.cells.oncell.ai'
    )
    expect(events.at(-1)?.stage).toBe('done')
  })

  test('a failed app start is non-fatal: done carries serviceError, build is kept', async () => {
    // Arrange
    addIdea(draftIdea())
    arrangeHealthyBuild()
    mockClient.startService.mockRejectedValue(
      new OnCellApiError({ status: 500, message: 'the app crashed on boot' })
    )

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — no live event, done still delivered with the build result.
    expect(events.map((event) => event.stage)).not.toContain('live')
    const done = events.at(-1)
    expect(done?.stage).toBe('done')
    expect(done?.result?.iteration).toMatchObject({ v: 1, checkPassed: true })
    expect(done?.result?.serviceError).toContain('crashed on boot')
    expect(done?.result?.liveUrl).toBeUndefined()

    // Registry: build recorded fine, service failure surfaced, no stale URL.
    const idea = getIdea('acme')
    expect(idea?.iterations).toHaveLength(1)
    expect(idea?.lastCheck?.exitCode).toBe(0)
    expect(idea?.serviceError).toContain('crashed on boot')
    expect(idea?.liveUrl).toBeUndefined()
  })

  test('falls back to the documented preview URL shape when getCell has none', async () => {
    // Arrange
    addIdea(draftIdea())
    arrangeHealthyBuild()
    mockClient.getCell.mockResolvedValue({ cell_id: 'dev--v-acme', status: 'running' })

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert
    expect(events.find((event) => event.stage === 'live')?.url).toBe(
      'https://dev--v-acme.cells.oncell.ai'
    )
  })

  test('returns 400 IDEA_REQUIRED when there is no idea text', async () => {
    // Arrange
    addIdea(draftIdea({ idea: undefined }))

    // Act
    const response = await buildRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('IDEA_REQUIRED')
  })
})
