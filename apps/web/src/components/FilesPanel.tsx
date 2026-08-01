'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { apiFetch, describeError } from './client-api'

interface FilesPanelProps {
  name: string
}

interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

interface DirState {
  entries?: readonly FileEntry[]
  isOpen: boolean
  error?: string
}

export function FilesPanel({ name }: FilesPanelProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [selected, setSelected] = useState<{ path: string; content: string } | undefined>(undefined)
  const [viewerError, setViewerError] = useState<string | undefined>(undefined)

  const loadDir = useCallback(
    async (path: string) => {
      try {
        const query = path.length > 0 ? `?path=${encodeURIComponent(path)}` : ''
        const data = await apiFetch<{ entries: FileEntry[] }>(
          `/api/ideas/${encodeURIComponent(name)}/files${query}`
        )
        setDirs((previous) => ({
          ...previous,
          [path]: { entries: data.entries, isOpen: true }
        }))
      } catch (loadError: unknown) {
        setDirs((previous) => ({
          ...previous,
          [path]: { isOpen: true, error: describeError(loadError) }
        }))
      }
    },
    [name]
  )

  useEffect(() => {
    void loadDir('')
  }, [loadDir])

  function toggleDir(path: string) {
    const current = dirs[path]
    if (current === undefined || current.entries === undefined) {
      void loadDir(path)
      return
    }
    setDirs((previous) => ({
      ...previous,
      [path]: { ...current, isOpen: !current.isOpen }
    }))
  }

  async function openFile(path: string) {
    setViewerError(undefined)
    try {
      const data = await apiFetch<{ path: string; content: string }>(
        `/api/ideas/${encodeURIComponent(name)}/files?read=${encodeURIComponent(path)}`
      )
      setSelected(data)
    } catch (readError: unknown) {
      setViewerError(describeError(readError))
    }
  }

  function renderDir(path: string, depth: number): ReactNode {
    const state = dirs[path]
    if (state === undefined) {
      return null
    }
    if (state.error !== undefined) {
      return (
        <p className="py-1 text-xs text-bad" style={{ paddingLeft: depth * 14 }}>
          {state.error}
        </p>
      )
    }
    if (state.entries === undefined || !state.isOpen) {
      return null
    }
    if (state.entries.length === 0) {
      return (
        <p className="py-1 font-mono text-xs text-faint" style={{ paddingLeft: depth * 14 }}>
          (empty)
        </p>
      )
    }
    return state.entries.map((entry) => (
      <div key={entry.path}>
        <button
          type="button"
          onClick={() => (entry.type === 'dir' ? toggleDir(entry.path) : void openFile(entry.path))}
          className={`block w-full truncate rounded px-1.5 py-1 text-left font-mono text-xs transition-colors hover:bg-raised ${
            selected?.path === entry.path ? 'text-gold' : entry.type === 'dir' ? 'text-fg' : 'text-muted'
          }`}
          style={{ paddingLeft: depth * 14 + 6 }}
        >
          {entry.type === 'dir' ? (dirs[entry.path]?.isOpen === true ? '▾ ' : '▸ ') : ''}
          {entry.name}
          {entry.type === 'dir' ? '/' : ''}
        </button>
        {entry.type === 'dir' && renderDir(entry.path, depth + 1)}
      </div>
    ))
  }

  return (
    <section className="panel p-5">
      <h2 className="section-title mb-4">Files</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
        <div className="max-h-80 overflow-y-auto rounded-md border border-edge bg-ink p-2">
          {dirs[''] === undefined ? (
            <p className="px-1.5 py-1 font-mono text-xs text-faint">loading…</p>
          ) : (
            renderDir('', 0)
          )}
        </div>
        <div className="max-h-80 overflow-auto rounded-md border border-edge bg-ink p-3">
          {viewerError !== undefined ? (
            <p className="text-xs text-bad">{viewerError}</p>
          ) : selected === undefined ? (
            <p className="font-mono text-xs text-faint">Select a file to view it.</p>
          ) : (
            <div>
              <p className="mb-2 font-mono text-[11px] text-gold">{selected.path}</p>
              <pre className="whitespace-pre font-mono text-xs leading-relaxed text-muted">
                {selected.content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
