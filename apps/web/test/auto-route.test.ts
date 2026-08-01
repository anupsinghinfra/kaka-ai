import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Auto-improve toggle route: the durable flag lives in the idea cell's kv;
 * turning it on for a built idea kicks one improve run so the Builder's
 * self-scheduling chain starts server-side.
 */

const mockClient = {
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  deployAgent: vi.fn(),
  invokeAgentTask: vi.fn(),
  snapshotCell: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => true,
  resetOnCellClientForTests: () => undefined
}))

import { GET as getAutoRoute, POST as postAutoRoute } from '@/app/api/ideas/[name]/auto/route'
import { addIdea, type Idea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

function getRequest(name: string): Request {
  return new Request(`http://localhost/api/ideas/${name}/auto`)
}

function postRequest(name: string, body: unknown): Request {
  return new Request(`http://localhost/api/ideas/${name}/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
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

describe('auto-improve route', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-auto-'))
    process.env.KAKA_HOME = home
    delete process.env.KAKA_BUILDER_MODE
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    delete process.env.KAKA_BUILDER_MODE
    rmSync(home, { recursive: true, force: true })
  })

  test('GET returns the cell-backed auto state with the next wake', async () => {
    // Arrange
    addIdea(builtIdea())
    mockClient.kvGet.mockImplementation(async (_cell: string, key: string) => {
      if (key === 'kaka:auto') return { value: 'on' }
      if (key === 'kaka:next-wake') return { value: '2026-08-01T02:30:00.000Z' }
      return { value: undefined }
    })

    // Act
    const response = await getAutoRoute(getRequest('acme'), params('acme'))
    const body = (await response.json()) as { auto: string; nextWakeAt?: string }

    // Assert
    expect(response.status).toBe(200)
    expect(body).toEqual({ auto: 'on', nextWakeAt: '2026-08-01T02:30:00.000Z' })
  })

  test('POST on sets the flag and kicks the improve chain for a built idea', async () => {
    // Arrange
    addIdea(builtIdea())
    mockClient.kvSet.mockResolvedValue({})
    mockClient.deployAgent.mockResolvedValue({ agentName: 'builder-acme', version: 2 })
    mockClient.snapshotCell.mockResolvedValue({ snapshot_key: 'snap-kick' })
    mockClient.invokeAgentTask.mockResolvedValue({ status: 'completed' })

    // Act
    const response = await postAutoRoute(postRequest('acme', { auto: 'on' }), params('acme'))
    const body = (await response.json()) as { auto: string; kicked: boolean }

    // Assert
    expect(response.status).toBe(200)
    expect(body).toEqual({ auto: 'on', kicked: true })
    expect(mockClient.kvSet).toHaveBeenCalledWith('dev--v-acme', 'kaka:auto', 'on')
    expect(mockClient.deployAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'builder-acme' })
    )
    expect(mockClient.invokeAgentTask).toHaveBeenCalledWith(
      'builder-acme',
      'improve',
      expect.objectContaining({ cell_id: 'dev--v-acme', snapshot_key: 'snap-kick' })
    )
  })

  test('POST on for an unbuilt idea only sets the flag', async () => {
    // Arrange
    addIdea(builtIdea({ builtAt: undefined, iterations: [] }))
    mockClient.kvSet.mockResolvedValue({})

    // Act
    const response = await postAutoRoute(postRequest('acme', { auto: 'on' }), params('acme'))
    const body = (await response.json()) as { auto: string; kicked: boolean }

    // Assert
    expect(body).toEqual({ auto: 'on', kicked: false })
    expect(mockClient.deployAgent).not.toHaveBeenCalled()
    expect(mockClient.invokeAgentTask).not.toHaveBeenCalled()
  })

  test('POST off sets the flag and never kicks', async () => {
    // Arrange
    addIdea(builtIdea())
    mockClient.kvSet.mockResolvedValue({})

    // Act
    const response = await postAutoRoute(postRequest('acme', { auto: 'off' }), params('acme'))
    const body = (await response.json()) as { auto: string; kicked: boolean }

    // Assert
    expect(body).toEqual({ auto: 'off', kicked: false })
    expect(mockClient.kvSet).toHaveBeenCalledWith('dev--v-acme', 'kaka:auto', 'off')
    expect(mockClient.invokeAgentTask).not.toHaveBeenCalled()
  })

  test('POST rejects local mode — the durable loop needs the agent', async () => {
    // Arrange
    process.env.KAKA_BUILDER_MODE = 'local'
    addIdea(builtIdea())

    // Act
    const response = await postAutoRoute(postRequest('acme', { auto: 'on' }), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('AUTO_UNAVAILABLE_LOCAL')
    expect(mockClient.kvSet).not.toHaveBeenCalled()
  })

  test('POST validates the body', async () => {
    // Arrange
    addIdea(builtIdea())

    // Act
    const response = await postAutoRoute(postRequest('acme', { auto: 'sideways' }), params('acme'))
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  test('404s for an unknown idea', async () => {
    // Act
    const response = await getAutoRoute(getRequest('ghost'), params('ghost'))

    // Assert
    expect(response.status).toBe(404)
  })
})
