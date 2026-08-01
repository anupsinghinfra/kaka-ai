'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiFetch, describeError } from './client-api'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface VentureActionsProps {
  name: string
}

type Dialog = 'none' | 'fork' | 'delete'

export function VentureActions({ name }: VentureActionsProps) {
  const router = useRouter()
  const [dialog, setDialog] = useState<Dialog>('none')
  const [forkName, setForkName] = useState('')
  const [keepRemote, setKeepRemote] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const isForkNameValid =
    forkName.trim().length >= 1 && forkName.trim().length <= 40 && NAME_RE.test(forkName.trim())

  async function run(action: () => Promise<void>) {
    setIsBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      await action()
    } catch (actionError: unknown) {
      setError(describeError(actionError))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSnapshot() {
    await run(async () => {
      const data = await apiFetch<{ snapshot: { key: string } }>(
        `/api/ventures/${encodeURIComponent(name)}/snapshot`,
        { method: 'POST' }
      )
      setMessage(`Snapshot created: ${data.snapshot.key}`)
      router.refresh()
    })
  }

  async function handleFork() {
    const target = forkName.trim()
    await run(async () => {
      await apiFetch(`/api/ventures/${encodeURIComponent(name)}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: target })
      })
      router.push(`/ventures/${encodeURIComponent(target)}`)
      router.refresh()
    })
  }

  async function handleDelete() {
    await run(async () => {
      const query = keepRemote ? '?keep_remote=true' : ''
      await apiFetch(`/api/ventures/${encodeURIComponent(name)}${query}`, { method: 'DELETE' })
      router.push('/')
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={handleSnapshot} disabled={isBusy}>
          Snapshot
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setDialog(dialog === 'fork' ? 'none' : 'fork')}
          disabled={isBusy}
        >
          Fork
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={() => setDialog(dialog === 'delete' ? 'none' : 'delete')}
          disabled={isBusy}
        >
          Delete
        </button>
      </div>

      {dialog === 'fork' && (
        <div className="panel flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">
            Fork copies the entire venture — code, files, and state — into a new cell.
          </p>
          <input
            className="field font-mono"
            placeholder="new-venture-name"
            value={forkName}
            onChange={(event) => setForkName(event.target.value)}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={handleFork}
              disabled={!isForkNameValid || isBusy}
            >
              {isBusy ? 'Forking…' : 'Fork venture'}
            </button>
            <button type="button" className="btn" onClick={() => setDialog('none')} disabled={isBusy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {dialog === 'delete' && (
        <div className="panel flex flex-col gap-3 border-bad/40 p-4">
          <p className="text-sm text-muted">
            Delete <span className="font-mono text-fg">{name}</span> from the local registry
            {keepRemote ? '.' : ' and delete its OnCell cell.'} This cannot be undone.
          </p>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={keepRemote}
              onChange={(event) => setKeepRemote(event.target.checked)}
              className="accent-[#d4a54a]"
            />
            Keep the remote cell (--keep-remote)
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-danger" onClick={handleDelete} disabled={isBusy}>
              {isBusy ? 'Deleting…' : 'Delete venture'}
            </button>
            <button type="button" className="btn" onClick={() => setDialog('none')} disabled={isBusy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {message !== undefined && <p className="font-mono text-xs text-good">{message}</p>}
      {error !== undefined && <p className="text-sm text-bad">{error}</p>}
    </div>
  )
}
