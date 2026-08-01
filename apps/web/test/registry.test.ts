import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  addVenture,
  getVenture,
  listVentures,
  loadRegistry,
  recordSnapshot,
  registryPath,
  removeVenture,
  saveRegistry,
  updateVenture,
  type Venture
} from '@/lib/registry'

function makeVenture(overrides: Partial<Venture> = {}): Venture {
  return {
    name: 'lemonade-stand',
    cellId: 'dev--v-lemonade-stand',
    customerId: 'v-lemonade-stand',
    idea: 'sell lemonade online',
    createdAt: '2026-08-01T00:00:00.000Z',
    snapshots: [],
    ...overrides
  }
}

describe('registry store', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-registry-'))
    process.env.KAKA_HOME = home
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    rmSync(home, { recursive: true, force: true })
  })

  test('returns the empty registry when no file exists', () => {
    // Act
    const registry = loadRegistry()

    // Assert
    expect(registry).toEqual({ version: 1, ventures: [] })
  })

  test('persists a venture round-trip through save and load', () => {
    // Arrange
    const venture = makeVenture()

    // Act
    addVenture(venture)

    // Assert
    expect(getVenture('lemonade-stand')).toEqual(venture)
    expect(listVentures()).toHaveLength(1)
  })

  test('writes valid, pretty JSON to KAKA_HOME/registry.json', () => {
    // Act
    addVenture(makeVenture())

    // Assert
    const raw = readFileSync(registryPath(), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; ventures: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.ventures).toHaveLength(1)
  })

  test('leaves no tmp files behind after an atomic write', () => {
    // Act
    addVenture(makeVenture())

    // Assert
    expect(readdirSync(home)).toEqual(['registry.json'])
  })

  test('throws when adding a venture whose name already exists', () => {
    // Arrange
    addVenture(makeVenture())

    // Act + Assert
    expect(() => addVenture(makeVenture())).toThrow(/already exists/)
  })

  test('updateVenture applies a patch without mutating other ventures', () => {
    // Arrange
    addVenture(makeVenture())
    addVenture(makeVenture({ name: 'other', cellId: 'dev--v-other', customerId: 'v-other' }))

    // Act
    const updated = updateVenture('lemonade-stand', { builtAt: '2026-08-02T00:00:00.000Z' })

    // Assert
    expect(updated.builtAt).toBe('2026-08-02T00:00:00.000Z')
    expect(getVenture('other')?.builtAt).toBeUndefined()
  })

  test('updateVenture throws for an unknown venture', () => {
    expect(() => updateVenture('ghost', { builtAt: 'now' })).toThrow(/not found/)
  })

  test('recordSnapshot appends to the snapshot history', () => {
    // Arrange
    addVenture(makeVenture())

    // Act
    recordSnapshot('lemonade-stand', { key: 'snap-1', at: '2026-08-01T01:00:00.000Z' })
    recordSnapshot('lemonade-stand', { key: 'snap-2', at: '2026-08-01T02:00:00.000Z' })

    // Assert
    expect(getVenture('lemonade-stand')?.snapshots.map((snapshot) => snapshot.key)).toEqual([
      'snap-1',
      'snap-2'
    ])
  })

  test('removeVenture deletes the entry and reports whether it existed', () => {
    // Arrange
    addVenture(makeVenture())

    // Act + Assert
    expect(removeVenture('lemonade-stand')).toBe(true)
    expect(removeVenture('lemonade-stand')).toBe(false)
    expect(listVentures()).toHaveLength(0)
  })

  test('throws a descriptive error when the file is not valid JSON', () => {
    // Arrange
    writeFileSync(registryPath(), 'not json', 'utf8')

    // Act + Assert
    expect(() => loadRegistry()).toThrow(/not valid JSON/)
  })

  test('throws a descriptive error when the file fails schema validation', () => {
    // Arrange
    writeFileSync(registryPath(), JSON.stringify({ version: 2, ventures: [] }), 'utf8')

    // Act + Assert
    expect(() => loadRegistry()).toThrow(/schema validation/)
  })

  test('saveRegistry rejects a structurally invalid registry', () => {
    // Arrange
    const invalid = { version: 1, ventures: [{ name: '' }] } as never

    // Act + Assert
    expect(() => saveRegistry(invalid)).toThrow()
  })
})
