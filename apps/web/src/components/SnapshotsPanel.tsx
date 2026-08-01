'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiFetch, describeError } from './client-api'

export interface SnapshotView {
  key: string
  at?: string
  sizeBytes?: number
}

interface SnapshotsPanelProps {
  name: string
  snapshots: readonly SnapshotView[]
}

function formatAt(at: string | undefined): string {
  if (at === undefined) {
    return ''
  }
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

export function SnapshotsPanel({ name, snapshots }: SnapshotsPanelProps) {
  const router = useRouter()
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  async function handleSnapshot() {
    setIsBusy(true)
    setError(undefined)
    try {
      await apiFetch(`/api/ventures/${encodeURIComponent(name)}/snapshot`, { method: 'POST' })
      router.refresh()
    } catch (snapshotError: unknown) {
      setError(describeError(snapshotError))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <section className="panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="section-title">Snapshots</h2>
        <button type="button" className="btn" onClick={handleSnapshot} disabled={isBusy}>
          {isBusy ? 'Snapshotting…' : 'Take snapshot'}
        </button>
      </div>
      {error !== undefined && <p className="mb-3 text-sm text-bad">{error}</p>}
      {snapshots.length === 0 ? (
        <p className="font-mono text-xs text-faint">
          No snapshots yet. A snapshot captures the whole venture at a point in time.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {snapshots.map((snapshot) => (
            <li
              key={snapshot.key}
              className="flex items-center justify-between gap-3 rounded border border-edge bg-ink px-2.5 py-1.5"
            >
              <span className="truncate font-mono text-xs text-fg">{snapshot.key}</span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {formatAt(snapshot.at)}
                {snapshot.sizeBytes !== undefined ? ` · ${snapshot.sizeBytes} B` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
