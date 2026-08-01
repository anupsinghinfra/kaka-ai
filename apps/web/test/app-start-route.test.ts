import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * App-start route tests: POST /api/ideas/[name]/app/start (re)starts the
 * built app's service and records liveUrl / serviceError on the idea.
 */

const mockClient = {
  getCell: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => true,
  resetOnCellClientForTests: () => undefined
}))

import { POST as appStartRoute } from '@/app/api/ideas/[name]/app/start/route'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function request(name: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/app/start`, { method: 'POST' })
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
    ...overrides
  }
}

describe('POST /api/ideas/[name]/app/start', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-app-start-'))
    process.env.KAKA_HOME = home
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    rmSync(home, { recursive: true, force: true })
  })

  test('starts the app, records the live URL, and clears a prior serviceError', async () => {
    // Arrange — nothing running yet; a previous start had failed.
    addIdea(builtIdea({ serviceError: 'the app crashed on boot' }))
    mockClient.stopService.mockRejectedValue(
      new OnCellApiError({ status: 503, code: 'NO_APP_RUNNING', message: 'no app running' })
    )
    mockClient.startService.mockResolvedValue({ running: true, port: 3000 })
    mockClient.getCell.mockResolvedValue({
      cell_id: 'dev--v-acme',
      status: 'running',
      preview_url: 'https://dev--v-acme.cells.oncell.ai'
    })

    // Act
    const response = await appStartRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { liveUrl: string }

    // Assert
    expect(response.status).toBe(200)
    expect(body.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(mockClient.startService).toHaveBeenCalledWith('dev--v-acme', {
      cmd: 'node src/server.js'
    })
    const idea = getIdea('acme')
    expect(idea?.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
    expect(idea?.serviceError).toBeUndefined()
  })

  test('falls back to the documented preview URL when getCell fails', async () => {
    // Arrange
    addIdea(builtIdea())
    mockClient.stopService.mockResolvedValue(undefined)
    mockClient.startService.mockResolvedValue({ running: true, port: 3000 })
    mockClient.getCell.mockRejectedValue(
      new OnCellApiError({ status: 500, message: 'status lookup down' })
    )

    // Act
    const response = await appStartRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { liveUrl: string }

    // Assert
    expect(response.status).toBe(200)
    expect(body.liveUrl).toBe('https://dev--v-acme.cells.oncell.ai')
  })

  test('a failed start returns 502 and records serviceError, clearing liveUrl', async () => {
    // Arrange
    addIdea(builtIdea({ liveUrl: 'https://dev--v-acme.cells.oncell.ai' }))
    mockClient.stopService.mockResolvedValue(undefined)
    mockClient.startService.mockRejectedValue(
      new OnCellApiError({ status: 500, message: 'the app crashed on boot' })
    )

    // Act
    const response = await appStartRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { error: { code: string; message: string } }

    // Assert
    expect(response.status).toBe(502)
    expect(body.error.code).toBe('SERVICE_START_FAILED')
    expect(body.error.message).toContain('crashed on boot')
    const idea = getIdea('acme')
    expect(idea?.serviceError).toContain('crashed on boot')
    expect(idea?.liveUrl).toBeUndefined()
  })

  test('returns 409 NOT_BUILT_YET before v1 exists', async () => {
    // Arrange
    addIdea(builtIdea({ builtAt: undefined, iterations: [] }))

    // Act
    const response = await appStartRoute(request('acme'), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('NOT_BUILT_YET')
    expect(mockClient.startService).not.toHaveBeenCalled()
  })

  test('returns 404 for an unknown idea', async () => {
    // Act
    const response = await appStartRoute(request('ghost'), params('ghost'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('IDEA_NOT_FOUND')
  })
})
