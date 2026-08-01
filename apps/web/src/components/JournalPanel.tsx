'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch, describeError } from './client-api'

interface JournalPanelProps {
  name: string
}

export function JournalPanel({ name }: JournalPanelProps) {
  const [entries, setEntries] = useState<readonly unknown[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const data = await apiFetch<{ entries: unknown[] }>(
        `/api/ideas/${encodeURIComponent(name)}/journal`
      )
      setEntries(data.entries)
    } catch (loadError: unknown) {
      setError(describeError(loadError))
    }
  }, [name])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="section-title">Journal</h2>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error !== undefined ? (
        <p className="text-sm text-bad">{error}</p>
      ) : entries === undefined ? (
        <p className="font-mono text-xs text-faint">loading…</p>
      ) : entries.length === 0 ? (
        <p className="font-mono text-xs text-faint">No journal entries yet.</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {entries.map((entry, index) => (
            <li
              key={index}
              className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-edge bg-ink px-2.5 py-1.5 font-mono text-xs text-muted"
            >
              {typeof entry === 'string' ? entry : JSON.stringify(entry)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
