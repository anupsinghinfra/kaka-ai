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
  metrics: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => false,
  resetOnCellClientForTests: () => undefined
}))

import { GET as listVenturesRoute, POST as createVentureRoute } from '@/app/api/ventures/route'
import { POST as execRoute } from '@/app/api/ventures/[name]/exec/route'
import { addVenture } from '@/lib/registry'

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

  describe('POST /api/ventures', () => {
    test('creates the cell, seeds identity, and registers the venture', async () => {
      // Arrange
      mockClient.createCell.mockResolvedValue({ cell_id: 'dev--v-acme', status: 'active' })
      mockClient.writeFile.mockResolvedValue({})
      mockClient.kvSet.mockResolvedValue({})

      // Act
      const response = await createVentureRoute(
        jsonRequest('http://localhost/api/ventures', { name: 'acme', idea: 'sell anvils' })
      )
      const body = (await response.json()) as { venture: { name: string; cellId: string } }

      // Assert
      expect(response.status).toBe(201)
      expect(body.venture.name).toBe('acme')
      expect(body.venture.cellId).toBe('dev--v-acme')
      expect(mockClient.createCell).toHaveBeenCalledWith({ customerId: 'v-acme' })
      expect(mockClient.writeFile).toHaveBeenCalledWith(
        'dev--v-acme',
        '.kaka/venture.json',
        expect.stringContaining('"acme"')
      )
      expect(mockClient.kvSet).toHaveBeenCalledWith('dev--v-acme', 'venture:name', 'acme')
    })

    test('rejects an invalid name with the machine-readable error envelope', async () => {
      // Act
      const response = await createVentureRoute(
        jsonRequest('http://localhost/api/ventures', { name: 'Not Kebab!' })
      )
      const body = (await response.json()) as { error: { code: string; message: string } }

      // Assert
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toMatch(/kebab-case/)
      expect(mockClient.createCell).not.toHaveBeenCalled()
    })

    test('returns 409 VENTURE_EXISTS for a duplicate name', async () => {
      // Arrange
      addVenture({
        name: 'acme',
        cellId: 'dev--v-acme',
        customerId: 'v-acme',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: []
      })

      // Act
      const response = await createVentureRoute(
        jsonRequest('http://localhost/api/ventures', { name: 'acme' })
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(409)
      expect(body.error.code).toBe('VENTURE_EXISTS')
    })
  })

  describe('GET /api/ventures', () => {
    test('lists ventures with live status, tolerating status errors as unknown', async () => {
      // Arrange
      addVenture({
        name: 'alive',
        cellId: 'dev--v-alive',
        customerId: 'v-alive',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: []
      })
      addVenture({
        name: 'ghost',
        cellId: 'dev--v-ghost',
        customerId: 'v-ghost',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: []
      })
      mockClient.getCell.mockImplementation(async (cellId: string) => {
        if (cellId === 'dev--v-alive') {
          return { cell_id: cellId, status: 'active' }
        }
        throw new OnCellApiError({ status: 404, message: 'no such cell' })
      })

      // Act
      const response = await listVenturesRoute()
      const body = (await response.json()) as { ventures: { name: string; status: string }[] }

      // Assert
      expect(response.status).toBe(200)
      const byName = Object.fromEntries(body.ventures.map((venture) => [venture.name, venture.status]))
      expect(byName).toEqual({ alive: 'active', ghost: 'unknown' })
    })
  })

  describe('POST /api/ventures/[name]/exec', () => {
    beforeEach(() => {
      addVenture({
        name: 'acme',
        cellId: 'dev--v-acme',
        customerId: 'v-acme',
        createdAt: '2026-08-01T00:00:00.000Z',
        snapshots: []
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
        jsonRequest('http://localhost/api/ventures/acme/exec', { cmd: 'node src/check.js' }),
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
        jsonRequest('http://localhost/api/ventures/acme/exec', { cmd: 'true' }),
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

    test('returns 404 for a venture that is not registered', async () => {
      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ventures/nope/exec', { cmd: 'true' }),
        params('nope')
      )
      const body = (await response.json()) as { error: { code: string } }

      // Assert
      expect(response.status).toBe(404)
      expect(body.error.code).toBe('VENTURE_NOT_FOUND')
    })

    test('rejects an empty command with a validation error', async () => {
      // Act
      const response = await execRoute(
        jsonRequest('http://localhost/api/ventures/acme/exec', { cmd: '' }),
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
