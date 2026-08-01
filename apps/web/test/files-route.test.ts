import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnCellApiError, type OnCellClient } from '@platform/oncell'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Files route tests focused on the nested-path regression: generated files
 * live at nested paths (src/server.js) and must be listed AND read by their
 * full relative paths, whatever shape list_files returns.
 */

const mockClient = {
  readFile: vi.fn(),
  listFiles: vi.fn()
}

vi.mock('@/lib/oncell', () => ({
  getOnCell: (): OnCellClient => mockClient as unknown as OnCellClient,
  isBuilderConfigured: () => false,
  resetOnCellClientForTests: () => undefined
}))

import { GET as filesRoute } from '@/app/api/ideas/[name]/files/route'
import { addIdea } from '@/lib/registry'

function params(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) }
}

describe('GET /api/ideas/[name]/files', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kaka-files-'))
    process.env.KAKA_HOME = home
    vi.clearAllMocks()
    addIdea({
      name: 'acme',
      cellId: 'dev--v-acme',
      customerId: 'v-acme',
      createdAt: '2026-08-01T00:00:00.000Z',
      snapshots: [],
      iterations: []
    })
  })

  afterEach(() => {
    delete process.env.KAKA_HOME
    rmSync(home, { recursive: true, force: true })
  })

  test('lists the root with nested files surfaced as directories', async () => {
    // Arrange — flat fully-qualified names, the shape from the screenshot bug.
    mockClient.listFiles.mockResolvedValue(['src/server.js', 'src/summarizer.js', 'check.js'])

    // Act
    const response = await filesRoute(
      new Request('http://localhost/api/ideas/acme/files'),
      params('acme')
    )
    const body = (await response.json()) as { entries: { name: string; path: string; type: string }[] }

    // Assert
    expect(response.status).toBe(200)
    expect(body.entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'check.js', path: 'check.js', type: 'file' }
    ])
    expect(mockClient.listFiles).toHaveBeenCalledWith('dev--v-acme')
  })

  test('lists a subdirectory with full relative paths, from bare names', async () => {
    // Arrange
    mockClient.listFiles.mockResolvedValue(['server.js', 'summarizer.js'])

    // Act
    const response = await filesRoute(
      new Request('http://localhost/api/ideas/acme/files?path=src'),
      params('acme')
    )
    const body = (await response.json()) as { entries: { path: string }[] }

    // Assert
    expect(response.status).toBe(200)
    expect(body.entries.map((entry) => entry.path)).toEqual([
      'src/server.js',
      'src/summarizer.js'
    ])
    expect(mockClient.listFiles).toHaveBeenCalledWith('dev--v-acme', 'src')
  })

  test('reads a file by its full nested path', async () => {
    // Arrange
    mockClient.readFile.mockResolvedValue({ content: 'const x = 1\n' })

    // Act
    const response = await filesRoute(
      new Request(`http://localhost/api/ideas/acme/files?read=${encodeURIComponent('src/server.js')}`),
      params('acme')
    )
    const body = (await response.json()) as { path: string; content: string }

    // Assert
    expect(response.status).toBe(200)
    expect(body).toEqual({ path: 'src/server.js', content: 'const x = 1\n' })
    expect(mockClient.readFile).toHaveBeenCalledWith('dev--v-acme', 'src/server.js')
  })

  test('passes an upstream 404 through when the file does not exist', async () => {
    // Arrange
    mockClient.readFile.mockRejectedValue(
      new OnCellApiError({ status: 404, message: 'no such file: nope.js' })
    )

    // Act
    const response = await filesRoute(
      new Request('http://localhost/api/ideas/acme/files?read=nope.js'),
      params('acme')
    )

    // Assert
    expect(response.status).toBe(404)
  })

  test('returns 404 for an unregistered idea', async () => {
    // Act
    const response = await filesRoute(
      new Request('http://localhost/api/ideas/ghost/files'),
      params('ghost')
    )
    const body = (await response.json()) as { error: { code: string } }

    // Assert
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('IDEA_NOT_FOUND')
  })
})
