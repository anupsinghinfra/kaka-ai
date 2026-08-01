'use client'

import { useState, type FormEvent } from 'react'
import { apiFetch, describeError } from './client-api'

interface ConsolePanelProps {
  name: string
}

interface ExecView {
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
}

interface RunRecord {
  id: number
  cmd: string
  result?: ExecView
  error?: string
}

const MAX_KEPT_RUNS = 5

export function ConsolePanel({ name }: ConsolePanelProps) {
  const [cmd, setCmd] = useState('')
  const [runs, setRuns] = useState<readonly RunRecord[]>([])
  const [isRunning, setIsRunning] = useState(false)

  async function handleRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = cmd.trim()
    if (trimmed.length === 0 || isRunning) {
      return
    }
    setIsRunning(true)
    const id = Date.now()
    try {
      const data = await apiFetch<{ result: ExecView }>(
        `/api/ideas/${encodeURIComponent(name)}/exec`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd: trimmed })
        }
      )
      setRuns((previous) => [{ id, cmd: trimmed, result: data.result }, ...previous].slice(0, MAX_KEPT_RUNS))
      setCmd('')
    } catch (runError: unknown) {
      setRuns((previous) =>
        [{ id, cmd: trimmed, error: describeError(runError) }, ...previous].slice(0, MAX_KEPT_RUNS)
      )
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="section-title mb-4">Console</h2>
      <form onSubmit={handleRun} className="flex gap-2">
        <input
          className="field font-mono"
          placeholder="node src/check.js"
          value={cmd}
          onChange={(event) => setCmd(event.target.value)}
          maxLength={8192}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={cmd.trim().length === 0 || isRunning}>
          {isRunning ? 'Running…' : 'Run'}
        </button>
      </form>
      <div className="mt-4 flex flex-col gap-3">
        {runs.map((run) => (
          <div key={run.id} className="rounded-md border border-edge bg-ink p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs text-fg">$ {run.cmd}</span>
              {run.result !== undefined && (
                <span
                  className={`shrink-0 font-mono text-[11px] ${
                    run.result.exit_code === 0 ? 'text-good' : 'text-bad'
                  }`}
                >
                  exit {run.result.exit_code} · {run.result.duration_ms}ms
                </span>
              )}
            </div>
            {run.error !== undefined && <p className="mt-2 text-xs text-bad">{run.error}</p>}
            {run.result !== undefined && (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted">
                {run.result.stdout.trim().length > 0 ? run.result.stdout : '(no stdout)'}
                {run.result.stderr.trim().length > 0 ? `\n[stderr]\n${run.result.stderr}` : ''}
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
