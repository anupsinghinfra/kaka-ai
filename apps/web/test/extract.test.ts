import { describe, expect, test } from 'vitest'
import { extractFileContent, extractFileEntries } from '@/lib/extract'

describe('extractFileEntries', () => {
  test('preserves nested paths when the root listing is flat fully-qualified names', () => {
    // Arrange — the shape behind the "no such file: summarizer.js" 404s.
    const result = ['src/server.js', 'src/summarizer.js', 'check.js']

    // Act
    const entries = extractFileEntries('', result)

    // Assert — src surfaces as a dir; check.js keeps its real path.
    expect(entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'check.js', path: 'check.js', type: 'file' }
    ])
  })

  test('qualifies bare names from a per-directory listing against the parent', () => {
    // Act
    const entries = extractFileEntries('src', ['server.js', 'summarizer.js'])

    // Assert
    expect(entries).toEqual([
      { name: 'server.js', path: 'src/server.js', type: 'file' },
      { name: 'summarizer.js', path: 'src/summarizer.js', type: 'file' }
    ])
  })

  test('does not double-join paths already qualified under the parent', () => {
    // Act
    const entries = extractFileEntries('src', ['src/server.js'])

    // Assert
    expect(entries).toEqual([{ name: 'server.js', path: 'src/server.js', type: 'file' }])
  })

  test('handles record entries with explicit path fields under a files wrapper', () => {
    // Arrange
    const result = {
      files: [
        { path: 'src/app.js', type: 'file' },
        { path: 'src/lib', type: 'dir' }
      ]
    }

    // Act
    const entries = extractFileEntries('src', result)

    // Assert
    expect(entries).toEqual([
      { name: 'lib', path: 'src/lib', type: 'dir' },
      { name: 'app.js', path: 'src/app.js', type: 'file' }
    ])
  })

  test('flattens a nested tree to the direct children of the listed directory', () => {
    // Arrange
    const result = [
      { name: 'src', type: 'dir', children: [{ name: 'server.js' }, { name: 'util.js' }] },
      { name: 'check.js' }
    ]

    // Act
    const entries = extractFileEntries('', result)

    // Assert
    expect(entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'check.js', path: 'check.js', type: 'file' }
    ])
  })

  test('derives full child paths from a nested tree when listing a subdirectory', () => {
    // Arrange
    const result = { name: 'src', type: 'dir', children: [{ name: 'server.js' }] }

    // Act
    const entries = extractFileEntries('src', result)

    // Assert
    expect(entries).toEqual([{ name: 'server.js', path: 'src/server.js', type: 'file' }])
  })

  test('unwraps a {result} envelope and treats trailing-slash strings as dirs', () => {
    // Act
    const entries = extractFileEntries('', { result: ['src/', 'README.md'] })

    // Assert
    expect(entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'README.md', path: 'README.md', type: 'file' }
    ])
  })

  test('dedupes a synthesized directory across many nested files', () => {
    // Act
    const entries = extractFileEntries('', ['src/a.js', 'src/b.js', 'src/deep/c.js'])

    // Assert
    expect(entries).toEqual([{ name: 'src', path: 'src', type: 'dir' }])
  })

  test('cleans leading ./ and duplicate slashes', () => {
    // Act
    const entries = extractFileEntries('', ['./check.js', 'src//app.js'])

    // Assert
    expect(entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'check.js', path: 'check.js', type: 'file' }
    ])
  })

  test('returns an empty list for unrecognized shapes', () => {
    expect(extractFileEntries('', 42)).toEqual([])
    expect(extractFileEntries('', undefined)).toEqual([])
  })
})

describe('extractFileContent', () => {
  test('accepts a bare string, a {content} field, and a {result} envelope', () => {
    expect(extractFileContent('hello')).toBe('hello')
    expect(extractFileContent({ content: 'hello' })).toBe('hello')
    expect(extractFileContent({ result: { content: 'hello' } })).toBe('hello')
  })

  test('returns undefined when no content is present', () => {
    expect(extractFileContent({ nope: true })).toBeUndefined()
  })
})
