import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Route handler tests with a mocked @platform/oncell client (injected via
 * the app's getOnCell accessor) and a temp-dir registry (KAKA_HOME).
 */

const mockClient = {
  createCell: vi.fn(),
  getCell: vi.fn(),
  listCells: vi.fn(),
  deleteCell: vi.fn(),
  pauseCell: vi.fn(),
  resumeCell: vi.fn(),
  exec: vi.fn(),
  snapshotCell: vi.fn(),
  listSnapshots: vi.fn(),
  forkCell: vi.fn(),
  request: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  listFiles: vi.fn(),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  journal: vi.fn(),
  logs: vi.fn(),
  metrics: vi.fn(),
  deployAgent: vi.fn(),
  invokeAgentTask: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => false,
  resetOnCellClientForTests: () => undefined
}))

import { GET as listIdeasRoute, POST as createIdeaRoute } from '@/app/api/ideas/route'
import { PATCH as patchIdeaRoute } from '@/app/api/ideas/[name]/route'
import { POST as execRoute } from '@/app/api/ideas/[name]/exec/route'
import { addIdea, getIdea } from '@/lib/registry'

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

describe('API routes', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-routes-'))
    process.env.KAKA_HOME = home
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    rmSync(home, { recursive: true, force: true })
  })

  describe('POST /api/ideas', () => {
    test('creates the cell, seeds identity, and registers the idea', async () => {
      // Arrange
      mockClient.createCell.mockResolvedValue({ cell_id: 'dev--v-acme', status: 'active' })
      mockClient.writeFile.mockResolvedValue({})
      mockClient.kvSet.mockResolvedValue({})

      // Act
      const response = await createIdeaRoute(
        jsonRequest('http://localhost/api/ideas', { name: 'acme', idea: 'sell anvils' })
      )
      const body = (await response.json()) as { idea: { name: string; cellId: string } }

      // Assert
      expect(response.status).toBe(201)
      expect(body.idea.name).toBe('acme')
      expect(body.idea.cellId).toBe('dev--v-acme')
      expect(mockClient.createCell).toHaveBeenCalledWith({ customerId: 'v-acme' })
      expect(mockClient.writeFile).toHaveBeenCalledWith(
        'dev--v-acme',
        '.kaka/idea.json',
        expect.stringContaining('"acme"')
      )
      expect(mockClient.kvSet).toHaveBeenCalledWith('dev--v-acme', 'idea:name', 'acme')
      // Agent mode (the default): the idea's Builder is deployed at birth.
      expect(mockClient.deployAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'builder-acme',
          source: expect.stringContaining('new Agent("builder-acme"'),
          manifest: expect.objectContaining({ capabilities: ['memory', 'cells', 'schedule'] })
        })
      )
    })

    test('a failed Builder deploy does not block idea creation', async () => {
      // Arrange
      mockClient.createCell.mockResolvedValue({ cell_id: 'dev--v-acme', status: 'active' })
      mockClient.writeFile.mockResolvedValue({})
      mockClient.kvSet.mockResolvedValue({})
      mockClient.deployAgent.mockRejectedValue(
        new OnCellApiError({ status: 503, message: 'agents unavailable' })
      )

      // Act
      const response = await createIdeaRoute(
        jsonRequest('http://localhost/api/ideas', { name: 'acme', idea: 'sell anvils' })
      )

      // Assert — the cell + registry entry are real; deploy is re-ensured per run.
      expect(response.status).toBe(201)
      expect(getIdea('acme')).toBeDefined()
    })

    test('rejects an invalid name with the machine-readable error envelope', async () => {
      // Act
      const response = await createIdeaRoute(
        jsonRequest('http://localhost/api/ideas', { name: 'Not Kebab!' })
      )
      const body = (await response.json()) as { error: { code: string; message: string } }

      // Assert
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toMatch(/kebab-case/)
      expect(mockClient.createCell).not.toHaveBeenCalled()
    })

    test('returns 409 IDEA_EXISTS for a duplicate name', async () => {
      // Arrange
      addIdea({
        name: 'acme',
        cellId: 'dev--v-acme',
        customerId: 'v-acme',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: [],
        iterations: []
      })

      // Act
      const response = await createIdeaRoute(
        jsonRequest('http://localhost/api/ideas', { name: 'acme' })
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(409)
      expect(body.error.code).toBe('IDEA_EXISTS')
    })
  })

  describe('GET /api/ideas', () => {
    test('lists ideas with live status, tolerating status errors as unknown', async () => {
      // Arrange
      addIdea({
        name: 'alive',
        cellId: 'dev--v-alive',
        customerId: 'v-alive',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: [],
        iterations: []
      })
      addIdea({
        name: 'ghost',
        cellId: 'dev--v-ghost',
        customerId: 'v-ghost',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: [],
        iterations: []
      })
      mockClient.getCell.mockImplementation(async (cellId: string) => {
        if (cellId === 'dev--v-alive') {
          return { cell_id: cellId, status: 'active' }
        }
        throw new OnCellApiError({ status: 404, message: 'no such cell' })
      })

      // Act
      const response = await listIdeasRoute()
      const body = (await response.json()) as { ideas: { name: string; status: string }[] }

      // Assert
      expect(response.status).toBe(200)
      const byName = Object.fromEntries(body.ideas.map((idea) => [idea.name, idea.status]))
      expect(byName).toEqual({ alive: 'active', ghost: 'unknown' })
    })
  })

  describe('PATCH /api/ideas/[name]', () => {
    beforeEach(() => {
      addIdea({
        name: 'acme',
        cellId: 'dev--v-acme',
        customerId: 'v-acme',
        idea: 'sell anvils',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: [],
        iterations: []
      })
    })

    test('updates the idea text', async () => {
      // Act
      const response = await patchIdeaRoute(
        new Request('http://localhost/api/ideas/acme', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idea: 'sell rocket anvils' })
        }),
        params('acme')
      )
      const body = (await response.json()) as { idea: { idea: string } }

      // Assert
      expect(response.status).toBe(200)
      expect(body.idea.idea).toBe('sell rocket anvils')
      expect(getIdea('acme')?.idea).toBe('sell rocket anvils')
    })

    test('rejects an empty idea text', async () => {
      // Act
      const response = await patchIdeaRoute(
        new Request('http://localhost/api/ideas/acme', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idea: '   ' })
        }),
        params('acme')
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(getIdea('acme')?.idea).toBe('sell anvils')
    })

    test('returns 404 for an unknown idea', async () => {
      // Act
      const response = await patchIdeaRoute(
        new Request('http://localhost/api/ideas/nope', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idea: 'anything' })
        }),
        params('nope')
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(404)
      expect(body.error.code).toBe('IDEA_NOT_FOUND')
    })
  })

  describe('POST /api/ideas/[name]/exec', () => {
    beforeEach(() => {
      addIdea({
        name: 'acme',
        cellId: 'dev--v-acme',
        customerId: 'v-acme',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: [],
        iterations: []
      })
    })

    test('runs the command with an auto idempotency key and returns the result', async () => {
      // Arrange
      mockClient.exec.mockResolvedValue({
        exit_code: 0,
        stdout: 'CHECK_OK\n',
        stderr: '',
        truncated: false,
        duration_ms: 42,
        replayed: false
      })

      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ideas/acme/exec', { cmd: 'node src/check.js' }),
        params('acme')
      )
      const body = (await response.json()) as { result: { exit_code: number; stdout: string } }

      // Assert
      expect(response.status).toBe(200)
      expect(body.result.exit_code).toBe(0)
      expect(body.result.stdout).toContain('CHECK_OK')
      expect(mockClient.exec).toHaveBeenCalledWith(
        'dev--v-acme',
        expect.objectContaining({
          cmd: 'node src/check.js',
          idempotencyKey: expect.stringMatching(/^web-exec-/)
        })
      )
    })

    test('maps OnCellApiError through with the upstream status preserved', async () => {
      // Arrange
      mockClient.exec.mockRejectedValue(
        new OnCellApiError({
          status: 429,
          code: 'RATE_LIMITED',
          message: 'slow down',
          remediation: 'retry later'
        })
      )

      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ideas/acme/exec', { cmd: 'true' }),
        params('acme')
      )
      const body = (await response.json()) as {
        error: { code: string; message: string; remediation?: string }
      }

      // Assert
      expect(response.status).toBe(429)
      expect(body.error).toEqual({
        code: 'RATE_LIMITED',
        message: 'slow down',
        remediation: 'retry later'
      })
    })

    test('returns 404 for an idea that is not registered', async () => {
      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ideas/nope/exec', { cmd: 'true' }),
        params('nope')
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(404)
      expect(body.error.code).toBe('IDEA_NOT_FOUND')
    })

    test('rejects an empty command with a validation error', async () => {
      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ideas/acme/exec', { cmd: '' }),
        params('acme')
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(mockClient.exec).not.toHaveBeenCalled()
    })
  })
})
