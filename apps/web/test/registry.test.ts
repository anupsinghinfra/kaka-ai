import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  addIdea,
  currentVersion,
  getIdea,
  legacyRegistryPath,
  listIdeas,
  loadRegistry,
  nextVersion,
  recordIteration,
  recordSnapshot,
  registryPath,
  removeIdea,
  saveRegistry,
  updateIdea,
  type Idea
} from '@/lib/registry'

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    name: 'lemonade-stand',
    cellId: 'dev--v-lemonade-stand',
    customerId: 'v-lemonade-stand',
    idea: 'sell lemonade online',
    createdAt: '2026-08-01T00:00:00.000Z',
    snapshots: [],
    iterations: [],
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
    expect(registry).toEqual({ version: 1, ideas: [] })
  })

  test('persists an idea round-trip through save and load', () => {
    // Arrange
    const idea = makeIdea()

    // Act
    addIdea(idea)

    // Assert
    expect(getIdea('lemonade-stand')).toEqual(idea)
    expect(listIdeas()).toHaveLength(1)
  })

  test('writes valid, pretty JSON to KAKA_HOME/ideas.json', () => {
    // Act
    addIdea(makeIdea())

    // Assert
    const raw = readFileSync(registryPath(), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; ideas: unknown[] }
    expect(registryPath().endsWith('ideas.json')).toBe(true)
    expect(parsed.version).toBe(1)
    expect(parsed.ideas).toHaveLength(1)
  })

  test('leaves no tmp files behind after an atomic write', () => {
    // Act
    addIdea(makeIdea())

    // Assert
    expect(readdirSync(home)).toEqual(['ideas.json'])
  })

  test('throws when adding an idea whose name already exists', () => {
    // Arrange
    addIdea(makeIdea())

    // Act + Assert
    expect(() => addIdea(makeIdea())).toThrow(/already exists/)
  })

  test('updateIdea applies a patch without mutating other ideas', () => {
    // Arrange
    addIdea(makeIdea())
    addIdea(makeIdea({ name: 'other', cellId: 'dev--v-other', customerId: 'v-other' }))

    // Act
    const updated = updateIdea('lemonade-stand', { builtAt: '2026-08-02T00:00:00.000Z' })

    // Assert
    expect(updated.builtAt).toBe('2026-08-02T00:00:00.000Z')
    expect(getIdea('other')?.builtAt).toBeUndefined()
  })

  test('updateIdea throws for an unknown idea', () => {
    expect(() => updateIdea('ghost', { builtAt: 'now' })).toThrow(/not found/)
  })

  test('recordSnapshot appends to the snapshot history', () => {
    // Arrange
    addIdea(makeIdea())

    // Act
    recordSnapshot('lemonade-stand', { key: 'snap-1', at: '2026-08-01T01:00:00.000Z' })
    recordSnapshot('lemonade-stand', { key: 'snap-2', at: '2026-08-01T02:00:00.000Z' })

    // Assert
    expect(getIdea('lemonade-stand')?.snapshots.map((snapshot) => snapshot.key)).toEqual([
      'snap-1',
      'snap-2'
    ])
  })

  test('recordIteration appends to the timeline in order', () => {
    // Arrange
    addIdea(makeIdea())

    // Act
    recordIteration('lemonade-stand', {
      v: 1,
      summary: 'Built the stand.',
      at: '2026-08-01T01:00:00.000Z',
      checkPassed: true
    })
    recordIteration('lemonade-stand', {
      v: 2,
      summary: 'Added flavors.',
      at: '2026-08-01T02:00:00.000Z',
      checkPassed: false,
      snapshotKey: 'snap-1'
    })

    // Assert
    const iterations = getIdea('lemonade-stand')?.iterations
    expect(iterations?.map((iteration) => iteration.v)).toEqual([1, 2])
    expect(iterations?.[1]?.snapshotKey).toBe('snap-1')
    expect(iterations?.[1]?.checkPassed).toBe(false)
  })

  test('recordIteration throws for an unknown idea', () => {
    expect(() =>
      recordIteration('ghost', { v: 1, summary: 'x', at: 'now', checkPassed: true })
    ).toThrow(/not found/)
  })

  test('round-trips liveUrl and serviceError through save and load', () => {
    // Arrange
    const idea = makeIdea({
      liveUrl: 'https://dev--v-lemonade-stand.cells.oncell.ai',
      serviceError: 'the app crashed on boot'
    })

    // Act
    addIdea(idea)

    // Assert
    const loaded = getIdea('lemonade-stand')
    expect(loaded?.liveUrl).toBe('https://dev--v-lemonade-stand.cells.oncell.ai')
    expect(loaded?.serviceError).toBe('the app crashed on boot')
  })

  test('updateIdea clears service state via an explicit undefined patch', () => {
    // Arrange
    addIdea(makeIdea({ liveUrl: 'https://x.cells.oncell.ai', serviceError: 'boom' }))

    // Act
    updateIdea('lemonade-stand', { serviceError: undefined })

    // Assert — cleared on load, gone from the persisted JSON.
    expect(getIdea('lemonade-stand')?.serviceError).toBeUndefined()
    expect(getIdea('lemonade-stand')?.liveUrl).toBe('https://x.cells.oncell.ai')
    expect(readFileSync(registryPath(), 'utf8')).not.toContain('serviceError')
  })

  test('removeIdea deletes the entry and reports whether it existed', () => {
    // Arrange
    addIdea(makeIdea())

    // Act + Assert
    expect(removeIdea('lemonade-stand')).toBe(true)
    expect(removeIdea('lemonade-stand')).toBe(false)
    expect(listIdeas()).toHaveLength(0)
  })

  test('saveRegistry rejects a structurally invalid registry', () => {
    // Arrange
    const invalid = { version: 1, ideas: [{ name: '' }] } as never

    // Act + Assert
    expect(() => saveRegistry(invalid)).toThrow()
  })

  describe('refuses foreign content instead of re-initializing', () => {
    test('load throws a descriptive error naming the file when it is not valid JSON', () => {
      // Arrange
      writeFileSync(registryPath(), 'not json', 'utf8')

      // Act + Assert
      expect(() => loadRegistry()).toThrow(/not valid JSON/)
      expect(() => loadRegistry()).toThrow(registryPath())
      expect(readFileSync(registryPath(), 'utf8')).toBe('not json')
    })

    test('load throws a descriptive error naming the file on foreign JSON content', () => {
      // Arrange
      writeFileSync(registryPath(), JSON.stringify({ some: 'other tool' }), 'utf8')

      // Act + Assert
      expect(() => loadRegistry()).toThrow(/does not look like a kaka idea registry/)
      expect(() => loadRegistry()).toThrow(registryPath())
    })

    test('save refuses to overwrite a file that is not valid JSON', () => {
      // Arrange
      writeFileSync(registryPath(), 'definitely not json', 'utf8')

      // Act + Assert
      expect(() => saveRegistry({ version: 1, ideas: [] })).toThrow(/refusing to overwrite/)
      expect(readFileSync(registryPath(), 'utf8')).toBe('definitely not json')
    })

    test('save refuses to overwrite foreign JSON content', () => {
      // Arrange
      const foreign = JSON.stringify({ todos: ['not ours'] })
      writeFileSync(registryPath(), foreign, 'utf8')

      // Act + Assert
      expect(() => saveRegistry({ version: 1, ideas: [] })).toThrow(/refusing to overwrite/)
      expect(readFileSync(registryPath(), 'utf8')).toBe(foreign)
    })
  })

  describe('legacy registry.json migration', () => {
    test('migrates a legacy registry once and writes ideas.json', () => {
      // Arrange
      const legacy = {
        version: 1,
        ventures: [
          {
            name: 'old-timer',
            cellId: 'dev--v-old-timer',
            customerId: 'v-old-timer',
            idea: 'a classic',
            createdAt: '2026-07-01T00:00:00.000Z',
            builtAt: '2026-07-02T00:00:00.000Z',
            snapshots: [{ key: 'snap-legacy', at: '2026-07-02T01:00:00.000Z' }]
          }
        ]
      }
      writeFileSync(legacyRegistryPath(), JSON.stringify(legacy), 'utf8')

      // Act
      const registry = loadRegistry()

      // Assert
      expect(registry.ideas).toHaveLength(1)
      expect(registry.ideas[0]?.name).toBe('old-timer')
      expect(registry.ideas[0]?.iterations).toEqual([])
      expect(existsSync(registryPath())).toBe(true)
      // The legacy file is left in place, untouched.
      expect(JSON.parse(readFileSync(legacyRegistryPath(), 'utf8'))).toEqual(legacy)
      expect(getIdea('old-timer')?.builtAt).toBe('2026-07-02T00:00:00.000Z')
    })

    test('ignores a legacy file that does not parse as ours', () => {
      // Arrange
      writeFileSync(legacyRegistryPath(), JSON.stringify({ version: 99, stuff: [] }), 'utf8')

      // Act
      const registry = loadRegistry()

      // Assert
      expect(registry).toEqual({ version: 1, ideas: [] })
      expect(existsSync(registryPath())).toBe(false)
    })

    test('prefers ideas.json over the legacy file when both exist', () => {
      // Arrange
      addIdea(makeIdea({ name: 'fresh' }))
      writeFileSync(
        legacyRegistryPath(),
        JSON.stringify({ version: 1, ventures: [makeIdea({ name: 'stale' })] }),
        'utf8'
      )

      // Act
      const names = listIdeas().map((idea) => idea.name)

      // Assert
      expect(names).toEqual(['fresh'])
    })
  })

  describe('version helpers', () => {
    test('an unbuilt idea is version 0 and ships v1 next', () => {
      const idea = makeIdea()
      expect(currentVersion(idea)).toBe(0)
      expect(nextVersion(idea)).toBe(1)
    })

    test('a legacy built idea without iterations counts as v1', () => {
      const idea = makeIdea({ builtAt: '2026-08-01T01:00:00.000Z' })
      expect(currentVersion(idea)).toBe(1)
      expect(nextVersion(idea)).toBe(2)
    })

    test('the highest iteration wins', () => {
      const idea = makeIdea({
        iterations: [
          { v: 1, summary: 'built', at: 't1', checkPassed: true },
          { v: 3, summary: 'improved', at: 't3', checkPassed: true },
          { v: 2, summary: 'improved', at: 't2', checkPassed: false }
        ]
      })
      expect(currentVersion(idea)).toBe(3)
      expect(nextVersion(idea)).toBe(4)
    })
  })
})
