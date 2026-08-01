/**
 * Tolerant extraction of values from OnCell request-helper results. The
 * public API does not pin the request-method response shapes, so these
 * helpers accept the plausible encodings (bare value, {content}/{value}
 * field, or the same nested under a {result} envelope). Mirrors the
 * scripts/venture extraction conventions.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapResult(value: unknown): unknown {
  if (isRecord(value) && 'result' in value) {
    return value['result']
  }
  return value
}

/** Extracts file content from a read_file result; undefined when absent. */
export function extractFileContent(result: unknown): string | undefined {
  const unwrapped = unwrapResult(result)
  if (typeof unwrapped === 'string') {
    return unwrapped
  }
  if (isRecord(unwrapped) && typeof unwrapped['content'] === 'string') {
    return unwrapped['content']
  }
  return undefined
}

/** A normalized directory entry from list_files. */
export interface FileEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'dir'
}

function joinCellPath(parent: string, name: string): string {
  if (parent.length === 0 || parent === '.' || parent === '/') {
    return name
  }
  return `${parent.replace(/\/$/, '')}/${name}`
}

function entryFromUnknown(parent: string, value: unknown): FileEntry | undefined {
  if (typeof value === 'string') {
    const isDir = value.endsWith('/')
    const name = value.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? value
    return { name, path: joinCellPath(parent, name), type: isDir ? 'dir' : 'file' }
  }
  if (!isRecord(value)) {
    return undefined
  }
  const rawName =
    typeof value['name'] === 'string'
      ? value['name']
      : typeof value['path'] === 'string'
        ? value['path']
        : undefined
  if (rawName === undefined || rawName.length === 0) {
    return undefined
  }
  const name = rawName.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? rawName
  const typeField = value['type']
  const isDir =
    typeField === 'dir' ||
    typeField === 'directory' ||
    value['is_dir'] === true ||
    value['isDirectory'] === true ||
    (typeof rawName === 'string' && rawName.endsWith('/'))
  const path = typeof value['path'] === 'string' ? value['path'] : joinCellPath(parent, name)
  return { name, path, type: isDir ? 'dir' : 'file' }
}

/** Normalizes a list_files result into sorted directory entries. */
export function extractFileEntries(parent: string, result: unknown): readonly FileEntry[] {
  const unwrapped = unwrapResult(result)
  let rawEntries: readonly unknown[] = []
  if (Array.isArray(unwrapped)) {
    rawEntries = unwrapped
  } else if (isRecord(unwrapped) && Array.isArray(unwrapped['files'])) {
    rawEntries = unwrapped['files']
  } else if (isRecord(unwrapped) && Array.isArray(unwrapped['entries'])) {
    rawEntries = unwrapped['entries']
  }
  const entries = rawEntries
    .map((entry) => entryFromUnknown(parent, entry))
    .filter((entry): entry is FileEntry => entry !== undefined)
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}

/** Normalizes a journal result into a list of renderable entries. */
export function extractJournalEntries(result: unknown): readonly unknown[] {
  const unwrapped = unwrapResult(result)
  if (Array.isArray(unwrapped)) {
    return unwrapped
  }
  if (isRecord(unwrapped)) {
    for (const key of ['entries', 'journal', 'events', 'lines']) {
      const nested = unwrapped[key]
      if (Array.isArray(nested)) {
        return nested
      }
    }
  }
  if (unwrapped === undefined || unwrapped === null) {
    return []
  }
  return [unwrapped]
}
