import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  readAutoImproveState,
  syncIterationsFromCell
} from '@/lib/builder-agent/sync'
import { addIdea, getIdea, type Idea } from '@/lib/registry'

/**
 * Cell → registry sync: the cell's kaka:iterations is the source of truth
 * in agent mode; auto state comes from kaka:auto / kaka:next-wake.
 */

const mockClient = { kvGet: vi.fn() }
const oncell = mockClient as unknown as OnCellClient

function baseIdea(overrides: Partial<Idea> = {}): Idea {
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

describe('syncIterationsFromCell', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-sync-'))
    process.env.KAKA_HOME = home
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    rmSync(home, { recursive: true, force: true })
  })

  test('adopts the cell timeline and derives builtAt from a passing v1', async () => {
    // Arrange
    addIdea(baseIdea())
    const cellIterations = [
      { v: 1, summary: 'Built it.', at: '2026-08-01T01:00:00.000Z', checkPassed: true },
      { v: 2, summary: 'Improved it.', at: '2026-08-01T02:00:00.000Z', checkPassed: true }
    ]
    mockClient.kvGet.mockResolvedValue({ value: JSON.stringify(cellIterations) })

    // Act
    const synced = await syncIterationsFromCell(oncell, baseIdea())

    // Assert
    expect(synced.iterations.map((iteration) => iteration.v)).toEqual([1, 2])
    expect(synced.builtAt).toBe('2026-08-01T01:00:00.000Z')
    expect(getIdea('acme')?.iterations).toHaveLength(2)
  })

  test('leaves the registry untouched when the cell has no timeline', async () => {
    // Arrange
    const existing = baseIdea({
      iterations: [
        { v: 1, summary: 'Built it.', at: '2026-08-01T01:00:00.000Z', checkPassed: true }
      ]
    })
    addIdea(existing)
    mockClient.kvGet.mockResolvedValue({ value: undefined })

    // Act
    const synced = await syncIterationsFromCell(oncell, existing)

    // Assert
    expect(synced.iterations).toHaveLength(1)
    expect(getIdea('acme')?.iterations).toHaveLength(1)
  })

  test('tolerates a kv read failure', async () => {
    // Arrange
    const existing = baseIdea()
    addIdea(existing)
    mockClient.kvGet.mockRejectedValue(new Error('cell unreachable'))

    // Act
    const synced = await syncIterationsFromCell(oncell, existing)

    // Assert
    expect(synced.iterations).toEqual([])
  })
})

describe('readAutoImproveState', () => {
  beforeEach(() => vi.clearAllMocks())

  test('reads the on flag and the next wake timestamp', async () => {
    // Arrange
    mockClient.kvGet.mockImplementation(async (_cell: string, key: string) => {
      if (key === 'kaka:auto') return { value: 'on' }
      if (key === 'kaka:next-wake') return { value: '2026-08-01T03:00:00.000Z' }
      return { value: undefined }
    })

    // Act
    const state = await readAutoImproveState(oncell, 'dev--v-acme')

    // Assert
    expect(state).toEqual({ auto: 'on', nextWakeAt: '2026-08-01T03:00:00.000Z' })
  })

  test('defaults to off on anything else, including read failures', async () => {
    // Arrange
    mockClient.kvGet.mockResolvedValue({ value: undefined })

    // Act + Assert
    expect(await readAutoImproveState(oncell, 'dev--v-acme')).toEqual({ auto: 'off' })

    // Arrange
    mockClient.kvGet.mockRejectedValue(new Error('cell unreachable'))

    // Act + Assert
    expect(await readAutoImproveState(oncell, 'dev--v-acme')).toEqual({ auto: 'off' })
  })
})
