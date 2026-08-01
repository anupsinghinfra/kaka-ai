import { describe, expect, test, vi } from 'vitest'
import { REQUIRED_CHECK_PATH } from '@/lib/builder/contract'
import {
  IMPROVE_TOOL_NAME,
  improveSystemPrompt,
  improveUserPrompt,
  readCurrentAppFiles
} from '@/lib/builder/improve'
import { parseBuilderResponse, type ContentBlockLike } from '@/lib/builder/parse'

function validPayload() {
  return {
    summary: 'Added flavor sorting so the menu reads naturally.',
    files: [
      { path: 'src/app.js', content: 'module.exports = 1\n' },
      { path: REQUIRED_CHECK_PATH, content: "console.log('CHECK_OK')\n" }
    ]
  }
}

describe('improve response parsing', () => {
  test('accepts an emit_improvement tool call', () => {
    // Arrange
    const content: ContentBlockLike[] = [
      { type: 'tool_use', name: IMPROVE_TOOL_NAME, input: validPayload() }
    ]

    // Act
    const result = parseBuilderResponse(content, IMPROVE_TOOL_NAME)

    // Assert
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.app.summary).toMatch(/flavor sorting/)
    }
  })

  test('ignores tool calls with the wrong name and reports the expected tool', () => {
    // Arrange
    const content: ContentBlockLike[] = [
      { type: 'tool_use', name: 'emit_app', input: validPayload() }
    ]

    // Act
    const result = parseBuilderResponse(content, IMPROVE_TOOL_NAME)

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(IMPROVE_TOOL_NAME)
    }
  })

  test('still enforces the full build contract (check file required)', () => {
    // Arrange
    const content: ContentBlockLike[] = [
      {
        type: 'tool_use',
        name: IMPROVE_TOOL_NAME,
        input: { summary: 'x', files: [{ path: 'src/app.js', content: 'y' }] }
      }
    ]

    // Act
    const result = parseBuilderResponse(content, IMPROVE_TOOL_NAME)

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(REQUIRED_CHECK_PATH)
    }
  })
})

describe('improve prompts', () => {
  test('the system prompt demands one user-felt improvement within the contract', () => {
    // Act
    const prompt = improveSystemPrompt()

    // Assert
    expect(prompt).toContain('SINGLE most valuable improvement')
    expect(prompt).toContain(REQUIRED_CHECK_PATH)
    expect(prompt).toContain(IMPROVE_TOOL_NAME)
    expect(prompt).toMatch(/self-test FAILED/)
    expect(prompt).toContain('COMPLETE updated file set')
  })

  test('the user prompt carries idea, changelog, last check, and full sources', () => {
    // Act
    const prompt = improveUserPrompt({
      name: 'lemonade-stand',
      idea: 'sell lemonade online',
      version: 3,
      iterations: [
        { v: 1, summary: 'Built the stand.', at: 't1', checkPassed: true },
        { v: 2, summary: 'Added flavors.', at: 't2', checkPassed: false }
      ],
      lastCheck: { exitCode: 1, output: 'TypeError: menu is not iterable' },
      files: [
        { path: 'src/app.js', content: 'const menu = null\n' },
        { path: 'src/check.js', content: 'process.exit(1)\n' }
      ]
    })

    // Assert
    expect(prompt).toContain('sell lemonade online')
    expect(prompt).toContain('shipping v3')
    expect(prompt).toContain('- v1 (check passed): Built the stand.')
    expect(prompt).toContain('- v2 (check FAILED): Added flavors.')
    expect(prompt).toContain('exit 1')
    expect(prompt).toContain('TypeError: menu is not iterable')
    expect(prompt).toContain('--- src/app.js ---')
    expect(prompt).toContain('const menu = null')
    expect(prompt).toContain('--- src/check.js ---')
  })

  test('the user prompt handles a missing last check', () => {
    // Act
    const prompt = improveUserPrompt({
      name: 'x',
      idea: 'y',
      version: 2,
      iterations: [],
      lastCheck: undefined,
      files: [{ path: 'a.js', content: 'z' }]
    })

    // Assert
    expect(prompt).toContain('(not yet run)')
  })
})

describe('readCurrentAppFiles', () => {
  test('walks nested directories and reads files by full path, skipping .kaka', async () => {
    // Arrange — root lists flat qualified names including the marker dir.
    const listFiles = vi.fn(async (_cellId: string, path?: string) => {
      if (path === undefined) {
        return ['src/server.js', 'package.json', '.kaka/idea.json']
      }
      if (path === 'src') {
        return ['server.js']
      }
      return []
    })
    const readFile = vi.fn(async (_cellId: string, path: string) => ({
      content: `// ${path}\n`
    }))

    // Act
    const files = await readCurrentAppFiles({ listFiles, readFile }, 'cell-1')

    // Assert
    expect(files.map((file) => file.path).sort()).toEqual(['package.json', 'src/server.js'])
    expect(readFile).toHaveBeenCalledWith('cell-1', 'src/server.js')
    expect(readFile).not.toHaveBeenCalledWith('cell-1', '.kaka/idea.json')
    expect(files.find((file) => file.path === 'src/server.js')?.content).toBe('// src/server.js\n')
  })

  test('returns an empty list for an empty cell', async () => {
    // Arrange
    const listFiles = vi.fn(async () => [])
    const readFile = vi.fn()

    // Act
    const files = await readCurrentAppFiles({ listFiles, readFile }, 'cell-1')

    // Assert
    expect(files).toEqual([])
    expect(readFile).not.toHaveBeenCalled()
  })
})
