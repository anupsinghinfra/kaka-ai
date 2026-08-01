/**
 * Tolerant extraction of values from OnCell request-helper results. The
 * public API does not pin the request-method response shapes, so these
 * helpers accept the plausible encodings (bare value, {content}/{value}
 * field, or the same nested under a {result} envelope).
 *
 * File listings are the trickiest: list_files may return a per-directory
 * listing of bare names, a flat list of fully-qualified relative paths, or
 * a nested tree with children. extractFileEntries normalizes ALL of these
 * into direct children of the requested directory with FULL relative paths
 * preserved, so the tree can always read a file by its real path.
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

/** Strips leading "./" and "/", trailing "/", and empty segments. */
function cleanPath(raw: string): string {
  return raw
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

function joinPaths(base: string, relative: string): string {
  if (base.length === 0) {
    return relative
  }
  return relative.length === 0 ? base : `${base}/${relative}`
}

interface CollectedPath {
  readonly path: string
  readonly isDir: boolean
}

const CHILD_LIST_KEYS = ['files', 'entries', 'children', 'items', 'tree'] as const

/**
 * Recursively collects (path, isDir) pairs from whatever shape list_files
 * returned: strings, records with name/path/type, wrapper objects, and
 * nested trees with children. `base` is the path context for bare names.
 */
function collectPaths(value: unknown, base: string, out: CollectedPath[]): void {
  if (typeof value === 'string') {
    const isDir = value.endsWith('/')
    const cleaned = cleanPath(value)
    if (cleaned.length > 0) {
      // Fully-qualified names carry their own directories; bare names are
      // relative to the listing context.
      out.push({ path: joinPaths(base, cleaned), isDir })
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, base, out)
    }
    return
  }
  if (!isRecord(value)) {
    return
  }
  const rawPath = typeof value['path'] === 'string' ? value['path'] : undefined
  const rawName = typeof value['name'] === 'string' ? value['name'] : undefined
  const raw = rawPath ?? rawName
  let entryPath: string | undefined
  if (raw !== undefined) {
    const cleaned = cleanPath(raw)
    if (cleaned.length > 0) {
      // An explicit path field is authoritative; a name is base-relative.
      entryPath = rawPath !== undefined ? cleaned : joinPaths(base, cleaned)
      const typeField = value['type']
      const hasChildren = Array.isArray(value['children'])
      const isDir =
        typeField === 'dir' ||
        typeField === 'directory' ||
        value['is_dir'] === true ||
        value['isDirectory'] === true ||
        raw.endsWith('/') ||
        hasChildren
      out.push({ path: entryPath, isDir })
    }
  }
  for (const key of CHILD_LIST_KEYS) {
    const nested = value[key]
    if (Array.isArray(nested)) {
      collectPaths(nested, entryPath ?? base, out)
    }
  }
}

/**
 * Resolves a collected path against the listed directory. Paths already
 * qualified under `parent` stay as-is; anything else is treated as relative
 * to `parent` (per-directory listings return bare names).
 */
function qualifyAgainstParent(parent: string, path: string): string {
  if (parent.length === 0) {
    return path
  }
  if (path === parent || path.startsWith(`${parent}/`)) {
    return path
  }
  return `${parent}/${path}`
}

/**
 * Normalizes a list_files result into the direct children of `parent`,
 * each with its full relative path. Files nested deeper than one level
 * surface as synthesized directory entries so lazy trees can descend.
 */
export function extractFileEntries(parent: string, result: unknown): readonly FileEntry[] {
  const cleanParent = cleanPath(parent)
  const collected: CollectedPath[] = []
  collectPaths(unwrapResult(result), '', collected)

  const byPath = new Map<string, FileEntry>()
  for (const item of collected) {
    const full = qualifyAgainstParent(cleanParent, item.path)
    if (full === cleanParent) {
      continue
    }
    const relative =
      cleanParent.length === 0 ? full : full.slice(cleanParent.length + 1)
    if (!full.startsWith(cleanParent.length === 0 ? '' : `${cleanParent}/`) || relative.length === 0) {
      continue
    }
    const segments = relative.split('/')
    const childName = segments[0] as string
    const childPath = joinPaths(cleanParent, childName)
    const isDir = segments.length > 1 ? true : item.isDir
    const existing = byPath.get(childPath)
    if (existing === undefined || (existing.type === 'file' && isDir)) {
      byPath.set(childPath, { name: childName, path: childPath, type: isDir ? 'dir' : 'file' })
    }
  }

  return [...byPath.values()].sort((a, b) => {
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
