'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface BuildPanelProps {
  name: string
  hasIdea: boolean
  builderReady: boolean
}

interface BuildResultView {
  summary: string
  files: string[]
  check: { exit_code: number; stdout: string; stderr: string }
}

type BuildStage = 'idle' | 'generating' | 'writing' | 'verifying' | 'done' | 'error'

interface StreamEvent {
  stage: string
  files?: number
  result?: BuildResultView
  error?: { code?: string; message?: string; remediation?: string }
}

const STAGE_LABELS: Record<string, string> = {
  generating: 'Generating the app with the Builder…',
  writing: 'Writing files into the cell…',
  verifying: 'Running the self-test in the cell…'
}

export function BuildPanel({ name, hasIdea, builderReady }: BuildPanelProps) {
  const router = useRouter()
  const [stage, setStage] = useState<BuildStage>('idle')
  const [fileCount, setFileCount] = useState<number | undefined>(undefined)
  const [result, setResult] = useState<BuildResultView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const isRunning = stage === 'generating' || stage === 'writing' || stage === 'verifying'

  function applyEvent(event: StreamEvent) {
    if (event.stage === 'generating' || event.stage === 'writing' || event.stage === 'verifying') {
      setStage(event.stage)
      if (typeof event.files === 'number') {
        setFileCount(event.files)
      }
      return
    }
    if (event.stage === 'done' && event.result !== undefined) {
      setStage('done')
      setResult(event.result)
      router.refresh()
      return
    }
    if (event.stage === 'error') {
      setStage('error')
      const base = event.error?.message ?? 'build failed'
      setError(event.error?.remediation !== undefined ? `${base} — ${event.error.remediation}` : base)
    }
  }

  async function handleBuild() {
    setStage('generating')
    setFileCount(undefined)
    setResult(undefined)
    setError(undefined)
    try {
      const response = await fetch(`/api/ventures/${encodeURIComponent(name)}/build`, {
        method: 'POST'
      })
      if (!response.ok || response.body === null) {
        const body = (await response.json().catch(() => ({}))) as StreamEvent
        setStage('error')
        const base = body.error?.message ?? `build failed with HTTP ${response.status}`
        setError(
          body.error?.remediation !== undefined ? `${base} — ${body.error.remediation}` : base
        )
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffered += decoder.decode(value, { stream: true })
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (line.length > 0) {
            applyEvent(JSON.parse(line) as StreamEvent)
          }
          newline = buffered.indexOf('\n')
        }
      }
    } catch (buildError: unknown) {
      setStage('error')
      setError(buildError instanceof Error ? buildError.message : String(buildError))
    }
  }

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">Builder</h2>
        <button
          type="button"
          className="btn-primary"
          onClick={handleBuild}
          disabled={!hasIdea || !builderReady || isRunning}
        >
          {isRunning ? 'Building…' : 'Build'}
        </button>
      </div>

      {!builderReady && (
        <p className="mt-3 rounded-md border border-gold/40 bg-gold/5 px-3 py-2 text-sm text-gold/90">
          Venture lifecycle works, but the Builder needs <span className="font-mono">ANTHROPIC_API_KEY</span>{' '}
          in the repo-root <span className="font-mono">.env</span>.
        </p>
      )}
      {builderReady && !hasIdea && (
        <p className="mt-3 text-sm text-muted">
          This venture has no idea recorded — the Builder needs one to work from.
        </p>
      )}

      {isRunning && (
        <div className="mt-4 flex items-center gap-3 text-sm text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-gold" />
          <span>
            {STAGE_LABELS[stage]}
            {stage === 'writing' && fileCount !== undefined ? ` (${fileCount} files)` : ''}
          </span>
        </div>
      )}

      {stage === 'error' && error !== undefined && (
        <p className="mt-4 text-sm text-bad">{error}</p>
      )}

      {result !== undefined && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${
                result.check.exit_code === 0
                  ? 'border-good/50 bg-good/10 text-good'
                  : 'border-bad/50 bg-bad/10 text-bad'
              }`}
            >
              {result.check.exit_code === 0 ? 'CHECK PASSED' : `CHECK FAILED (exit ${result.check.exit_code})`}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-fg">{result.summary}</p>
          <div>
            <p className="section-title mb-2">Files written</p>
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted">
              {result.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="section-title mb-2">Check output</p>
            <pre className="overflow-x-auto rounded-md border border-edge bg-ink p-3 font-mono text-xs text-muted">
              {result.check.stdout.trim().length > 0 ? result.check.stdout : '(no stdout)'}
              {result.check.stderr.trim().length > 0 ? `\n[stderr]\n${result.check.stderr}` : ''}
            </pre>
          </div>
        </div>
      )}
    </section>
  )
}
