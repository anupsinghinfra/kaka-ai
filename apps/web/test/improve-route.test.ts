import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Improve route tests: mocked @platform/oncell (via getOnCell) and a mocked
 * Anthropic SDK — no live calls. Exercises the full NDJSON iteration flow
 * and the registry side effects (iteration record, snapshot key, lastCheck).
 */

const mockClient = {
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  snapshotCell: vi.fn(),
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

import { POST as improveRoute } from '@/app/api/ideas/[name]/improve/route'
import { IMPROVE_TOOL_NAME } from '@/lib/builder/improve'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function request(name: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/improve`, { method: 'POST' })
}

interface StreamEvent {
  stage: string
  files?: number
  path?: string
  url?: string
  result?: {
    iteration: { v: number; summary: string; checkPassed: boolean; snapshotKey?: string }
    files: string[]
    check: { exit_code: number }
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

function builtIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    name: 'acme',
    cellId: 'dev--v-acme',
    customerId: 'v-acme',
    idea: 'sell anvils online',
    createdAt: '2026-08-01T00:00:00.000Z',
    builtAt: '2026-08-01T01:00:00.000Z',
    snapshots: [],
    iterations: [
      { v: 1, summary: 'Built the anvil shop.', at: '2026-08-01T01:00:00.000Z', checkPassed: true }
    ],
    lastCheck: { exitCode: 0, output: 'CHECK_OK' },
    ...overrides
  }
}

function improvementResponse(summary: string) {
  return {
    content: [
      {
        type: 'tool_use',
        name: IMPROVE_TOOL_NAME,
        input: {
          summary,
          files: [
            { path: 'src/app.js', content: 'module.exports = 2\n' },
            { path: 'src/check.js', content: "console.log('CHECK_OK')\n" }
          ]
        }
      }
    ]
  }
}

function arrangeHealthyCell(): void {
  mockClient.listFiles.mockImplementation(async (_cellId: string, path?: string) => {
    if (path === undefined) {
      return ['src/app.js', 'src/check.js', '.kaka/idea.json']
    }
    if (path === 'src') {
      return ['app.js', 'check.js']
    }
    return []
  })
  mockClient.readFile.mockResolvedValue({ content: 'module.exports = 1\n' })
  mockClient.writeFile.mockResolvedValue({})
  mockClient.snapshotCell.mockResolvedValue({
    snapshot_key: 'snap-improve-1',
    created_at: '2026-08-01T02:00:00.000Z'
  })
  mockClient.stopService.mockResolvedValue(undefined)
  mockClient.startService.mockResolvedValue({ running: true, port: 3000 })
  mockClient.getCell.mockResolvedValue({
    cell_id: 'dev--v-acme',
    status: 'running',
    preview_url: 'https://dev--v-acme.cells.oncell.ai'
  })
}

describe('POST /api/ideas/[name]/improve', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-improve-'))
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

  test('streams the full iteration and records v2 with the snapshot key', async () => {
    // Arrange
    addIdea(builtIdea())
    arrangeHealthyCell()
    mockClient.exec.mockResolvedValue({
      exit_code: 0,
      stdout: 'CHECK_OK\n',
      stderr: '',
      truncated: false,
      duration_ms: 12,
      replayed: false
    })
    mockFinalMessage.mockResolvedValue(
      improvementResponse('Added a search box so shoppers find anvils faster.')
    )

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — stage narrative then done.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('ndjson')
    expect(events.map((event) => event.stage)).toEqual([
      'reading',
      'snapshotting',
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
      'src/app.js',
      'src/check.js'
    ])
    const live = events.find((event) => event.stage === 'live')
    expect(live?.url).toBe('https://dev--v-acme.cells.oncell.ai')
    const done = events.at(-1)
    expect(done?.result?.iteration).toMatchObject({
      v: 2,
      summary: 'Added a search box so shoppers find anvils faster.',
      checkPassed: true,
      snapshotKey: 'snap-improve-1'
    })
    expect(done?.result?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    // The app was restarted with the contract entry point.
    expect(mockClient.startService).toHaveBeenCalledWith('dev--v-acme', {
      cmd: 'node src/server.js'
    })

    // Snapshot is the rollback point: taken BEFORE any file is written.
    const snapshotOrder = mockClient.snapshotCell.mock.invocationCallOrder[0]
    const firstWriteOrder = mockClient.writeFile.mock.invocationCallOrder[0]
    expect(snapshotOrder).toBeLessThan(firstWriteOrder as number)

    // Registry side effects.
    const idea = getIdea('acme')
    expect(idea?.iterations.map((iteration) => iteration.v)).toEqual([1, 2])
    expect(idea?.iterations[1]?.snapshotKey).toBe('snap-improve-1')
    expect(idea?.lastCheck?.exitCode).toBe(0)
    expect(idea?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(idea?.serviceError).toBeUndefined()
  })

  test('a failed check is recorded as a failed iteration and fed forward', async () => {
    // Arrange
    addIdea(builtIdea())
    arrangeHealthyCell()
    mockClient.exec.mockResolvedValue({
      exit_code: 1,
      stdout: '',
      stderr: 'TypeError: boom',
      truncated: false,
      duration_ms: 12,
      replayed: false
    })
    mockFinalMessage.mockResolvedValue(improvementResponse('Tried something ambitious.'))

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — the run completes (no rollback) but the iteration is marked failed.
    const done = events.at(-1)
    expect(done?.stage).toBe('done')
    expect(done?.result?.iteration.checkPassed).toBe(false)
    const idea = getIdea('acme')
    expect(idea?.iterations[1]?.checkPassed).toBe(false)
    expect(idea?.lastCheck?.exitCode).toBe(1)
    expect(idea?.lastCheck?.output).toContain('TypeError: boom')
  })

  test('retries once on an invalid model response, then succeeds', async () => {
    // Arrange
    addIdea(builtIdea())
    arrangeHealthyCell()
    mockClient.exec.mockResolvedValue({
      exit_code: 0,
      stdout: 'CHECK_OK\n',
      stderr: '',
      truncated: false,
      duration_ms: 5,
      replayed: false
    })
    mockFinalMessage
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'I refuse.' }] })
      .mockResolvedValueOnce(improvementResponse('Second try shipped.'))

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert
    expect(events.at(-1)?.stage).toBe('done')
    expect(mockFinalMessage).toHaveBeenCalledTimes(2)
  })

  test('emits a stream error when the model fails twice', async () => {
    // Arrange
    addIdea(builtIdea())
    arrangeHealthyCell()
    mockFinalMessage.mockResolvedValue({ content: [{ type: 'text', text: 'nope' }] })

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const events = await readEvents(response)

    // Assert — no iteration recorded, error surfaced on the stream.
    const last = events.at(-1)
    expect(last?.stage).toBe('error')
    expect(last?.error?.code).toBe('BUILDER_INVALID_OUTPUT')
    expect(getIdea('acme')?.iterations).toHaveLength(1)
    expect(mockClient.writeFile).not.toHaveBeenCalled()
  })

  test('returns 409 NOT_BUILT_YET before v1 exists', async () => {
    // Arrange
    addIdea(builtIdea({ builtAt: undefined, iterations: [], lastCheck: undefined }))

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('NOT_BUILT_YET')
    expect(mockClient.snapshotCell).not.toHaveBeenCalled()
  })

  test('returns 400 IDEA_REQUIRED when there is no idea text', async () => {
    // Arrange
    addIdea(builtIdea({ idea: undefined }))

    // Act
    const response = await improveRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('IDEA_REQUIRED')
  })

  test('returns 404 for an unknown idea', async () => {
    // Act
    const response = await improveRoute(request('ghost'), params('ghost'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('IDEA_NOT_FOUND')
  })
})
