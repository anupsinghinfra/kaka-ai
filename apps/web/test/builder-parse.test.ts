import { describe, expect, test } from 'vitest'
import {
  BUILDER_TOOL_NAME,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  REQUIRED_CHECK_PATH
} from '@/lib/builder/contract'
import {
  parseBuilderResponse,
  validateBuilderApp,
  type ContentBlockLike
} from '@/lib/builder/parse'

function validPayload() {
  return {
    summary: 'A tiny app.',
    files: [
      { path: 'src/app.js', content: 'module.exports = 1\n' },
      { path: REQUIRED_CHECK_PATH, content: "console.log('CHECK_OK')\n" }
    ]
  }
}

function toolResponse(input: unknown): ContentBlockLike[] {
  return [{ type: 'tool_use', name: BUILDER_TOOL_NAME, input }]
}

describe('parseBuilderResponse', () => {
  test('accepts a valid emit_app tool call', () => {
    // Act
    const result = parseBuilderResponse(toolResponse(validPayload()))

    // Assert
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.app.files).toHaveLength(2)
      expect(result.app.summary).toBe('A tiny app.')
    }
  })

  test('accepts a fenced json block when no tool call is present', () => {
    // Arrange
    const text = `Here is the app:\n\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\``

    // Act
    const result = parseBuilderResponse([{ type: 'text', text }])

    // Assert
    expect(result.ok).toBe(true)
  })

  test('rejects a response with neither tool call nor JSON', () => {
    // Act
    const result = parseBuilderResponse([{ type: 'text', text: 'I cannot do that.' }])

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/neither/)
    }
  })

  test('rejects malformed JSON in the fenced block with a parse error message', () => {
    // Arrange
    const text = '```json\n{"summary": "oops", "files": [}\n```'

    // Act
    const result = parseBuilderResponse([{ type: 'text', text }])

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/not valid JSON/)
    }
  })

  test('ignores tool_use blocks for other tools and falls back to text', () => {
    // Arrange
    const blocks: ContentBlockLike[] = [
      { type: 'tool_use', name: 'something_else', input: {} },
      { type: 'text', text: `\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\`` }
    ]

    // Act
    const result = parseBuilderResponse(blocks)

    // Assert
    expect(result.ok).toBe(true)
  })
})

describe('validateBuilderApp', () => {
  test('rejects a payload missing the required check file', () => {
    // Arrange
    const payload = {
      summary: 'no check',
      files: [{ path: 'src/app.js', content: 'x' }]
    }

    // Act
    const result = validateBuilderApp(payload)

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(REQUIRED_CHECK_PATH)
    }
  })

  test('rejects more files than the contract allows', () => {
    // Arrange
    const files = Array.from({ length: MAX_FILES + 1 }, (_, index) => ({
      path: `src/file-${index}.js`,
      content: 'x'
    }))

    // Act
    const result = validateBuilderApp({ summary: 'too many', files })

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/too many files/)
    }
  })

  test('rejects oversize total content', () => {
    // Arrange
    const payload = {
      summary: 'huge',
      files: [
        { path: REQUIRED_CHECK_PATH, content: "console.log('CHECK_OK')" },
        { path: 'src/blob.js', content: 'a'.repeat(MAX_TOTAL_BYTES) }
      ]
    }

    // Act
    const result = validateBuilderApp(payload)

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/max 204800/)
    }
  })

  test.each(['/etc/passwd', '../escape.js', 'src/../../up.js', 'a//b.js'])(
    'rejects unsafe path %s',
    (path) => {
      // Arrange
      const payload = {
        summary: 'bad path',
        files: [
          { path, content: 'x' },
          { path: REQUIRED_CHECK_PATH, content: 'x' }
        ]
      }

      // Act
      const result = validateBuilderApp(payload)

      // Assert
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/unsafe file path/)
      }
    }
  )

  test('rejects duplicate file paths', () => {
    // Arrange
    const payload = {
      summary: 'dupes',
      files: [
        { path: REQUIRED_CHECK_PATH, content: 'a' },
        { path: REQUIRED_CHECK_PATH, content: 'b' }
      ]
    }

    // Act
    const result = validateBuilderApp(payload)

    // Assert
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/duplicate/)
    }
  })

  test('rejects a payload that is not an object', () => {
    // Act
    const result = validateBuilderApp('nope')

    // Assert
    expect(result.ok).toBe(false)
  })
})
