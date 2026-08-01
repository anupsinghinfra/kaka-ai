'use client'

/**
 * The idea page's core loop: editable idea text, product status pill, one
 * primary action (Build v1 → Improve), the auto-improve toggle, and the
 * iteration timeline — the "watch it get better" feed. Build and improve
 * both stream NDJSON stage events from the API.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, describeError } from './client-api'

export interface IterationView {
  v: number
  summary: string
  at: string
  checkPassed: boolean
}

interface IdeaWorkspaceProps {
  name: string
  idea?: string
  builderReady: boolean
  iterations: IterationView[]
}

interface CheckView {
  exit_code: number
  stdout: string
  stderr: string
}

interface StreamEvent {
  stage: string
  files?: number
  result?: {
    iteration?: IterationView
    summary?: string
    files?: string[]
    check?: CheckView
  }
  error?: { code?: string; message?: string; remediation?: string }
}

type RunKind = 'building' | 'improving'

interface RunState {
  kind: RunKind
  stage: string
  files?: number
  targetV: number
}

const AUTO_MAX_RUNS_PER_SESSION = 10
const AUTO_PAUSE_MS = 2500

const BUILD_STAGE_LABELS: Record<string, string> = {
  generating: 'Claude is writing your v1…',
  writing: 'Shipping the code into your workspace…',
  verifying: 'Proving it runs…'
}

const IMPROVE_STAGE_LABELS: Record<string, string> = {
  reading: 'Reading the current app…',
  snapshotting: 'Saving a restore point…',
  generating: 'Finding the most valuable improvement…',
  writing: 'Shipping the update…',
  verifying: 'Proving it still runs…'
}

function maxVersion(iterations: readonly IterationView[]): number {
  return iterations.reduce((max, iteration) => Math.max(max, iteration.v), 0)
}

function formatAt(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readNdjsonStream(
  response: Response,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  if (response.body === null) {
    throw new Error('the server returned no stream')
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
        onEvent(JSON.parse(line) as StreamEvent)
      }
      newline = buffered.indexOf('\n')
    }
  }
}

export function IdeaWorkspace({ name, idea, builderReady, iterations: initial }: IdeaWorkspaceProps) {
  const router = useRouter()
  const [iterations, setIterations] = useState<readonly IterationView[]>(initial)
  const [run, setRun] = useState<RunState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [lastCheck, setLastCheck] = useState<CheckView | undefined>(undefined)

  const [isEditingIdea, setIsEditingIdea] = useState(false)
  const [ideaDraft, setIdeaDraft] = useState(idea ?? '')
  const [isSavingIdea, setIsSavingIdea] = useState(false)
  const [ideaText, setIdeaText] = useState(idea ?? '')

  const [isAutoOn, setIsAutoOn] = useState(false)
  const [autoRuns, setAutoRuns] = useState(0)
  const [isKeepGoingPromptVisible, setIsKeepGoingPromptVisible] = useState(false)

  const autoRef = useRef(false)
  const loopActiveRef = useRef(false)
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      autoRef.current = false
    }
  }, [])

  const version = maxVersion(iterations)
  const hasIdeaText = ideaText.trim().length > 0
  const isRunning = run !== undefined
  const canAct = builderReady && hasIdeaText && !isRunning

  function statusPill(): { label: string; tone: string } {
    if (run?.kind === 'building') {
      return { label: 'building', tone: 'border-gold/50 bg-gold/10 text-gold' }
    }
    if (run?.kind === 'improving' || isAutoOn) {
      const target = run?.targetV ?? version + 1
      return { label: `improving — v${target}`, tone: 'border-gold/50 bg-gold/10 text-gold' }
    }
    if (version === 0) {
      return { label: 'draft', tone: 'border-edge bg-raised text-muted' }
    }
    return { label: `v${version}`, tone: 'border-good/50 bg-good/10 text-good' }
  }

  /** Runs one streamed pass (build or improve). Resolves true on success. */
  async function runStreamedPass(kind: RunKind): Promise<boolean> {
    const targetV = kind === 'building' ? 1 : maxVersionRefSafe() + 1
    setError(undefined)
    setLastCheck(undefined)
    setRun({ kind, stage: kind === 'building' ? 'generating' : 'reading', targetV })
    try {
      const endpoint = kind === 'building' ? 'build' : 'improve'
      const response = await fetch(`/api/ideas/${encodeURIComponent(name)}/${endpoint}`, {
        method: 'POST'
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as StreamEvent
        const base = body.error?.message ?? `request failed with HTTP ${response.status}`
        setError(body.error?.remediation !== undefined ? `${base} — ${body.error.remediation}` : base)
        return false
      }
      let succeeded = false
      await readNdjsonStream(response, (event) => {
        if (event.stage === 'done') {
          succeeded = true
          applyDone(kind, event)
          return
        }
        if (event.stage === 'error') {
          const base = event.error?.message ?? 'the run failed'
          setError(
            event.error?.remediation !== undefined ? `${base} — ${event.error.remediation}` : base
          )
          return
        }
        setRun({ kind, stage: event.stage, files: event.files, targetV })
      })
      return succeeded
    } catch (streamError: unknown) {
      setError(describeError(streamError))
      return false
    } finally {
      if (isMountedRef.current) {
        setRun(undefined)
      }
    }
  }

  const iterationsRef = useRef(iterations)
  iterationsRef.current = iterations
  function maxVersionRefSafe(): number {
    return maxVersion(iterationsRef.current)
  }

  function applyDone(kind: RunKind, event: StreamEvent): void {
    const iteration = event.result?.iteration
    if (iteration !== undefined) {
      setIterations((previous) =>
        kind === 'building' ? [iteration] : [...previous.filter((it) => it.v !== iteration.v), iteration]
      )
    }
    if (event.result?.check !== undefined) {
      setLastCheck(event.result.check)
    }
    router.refresh()
  }

  async function handleBuild(): Promise<void> {
    await runStreamedPass('building')
  }

  async function handleImproveOnce(): Promise<void> {
    await runStreamedPass('improving')
  }

  /** The auto-improve loop: sequential iterations with a breather between. */
  async function autoLoop(startCount: number): Promise<void> {
    if (loopActiveRef.current) {
      return
    }
    loopActiveRef.current = true
    let runs = startCount
    try {
      while (autoRef.current && isMountedRef.current) {
        if (runs >= AUTO_MAX_RUNS_PER_SESSION) {
          setIsKeepGoingPromptVisible(true)
          return
        }
        const ok = await runStreamedPass('improving')
        runs += 1
        setAutoRuns(runs)
        if (!ok) {
          autoRef.current = false
          setIsAutoOn(false)
          return
        }
        if (autoRef.current) {
          await sleep(AUTO_PAUSE_MS)
        }
      }
    } finally {
      loopActiveRef.current = false
    }
  }

  function handleAutoToggle(): void {
    if (isAutoOn) {
      autoRef.current = false
      setIsAutoOn(false)
      setIsKeepGoingPromptVisible(false)
      return
    }
    autoRef.current = true
    setIsAutoOn(true)
    setIsKeepGoingPromptVisible(false)
    void autoLoop(autoRuns)
  }

  function handleKeepGoing(): void {
    setAutoRuns(0)
    setIsKeepGoingPromptVisible(false)
    autoRef.current = true
    setIsAutoOn(true)
    void autoLoop(0)
  }

  async function handleSaveIdea(): Promise<void> {
    const trimmed = ideaDraft.trim()
    if (trimmed.length === 0 || isSavingIdea) {
      return
    }
    setIsSavingIdea(true)
    setError(undefined)
    try {
      await apiFetch(`/api/ideas/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idea: trimmed })
      })
      setIdeaText(trimmed)
      setIsEditingIdea(false)
      router.refresh()
    } catch (saveError: unknown) {
      setError(describeError(saveError))
    } finally {
      setIsSavingIdea(false)
    }
  }

  const pill = statusPill()
  const stageLabel =
    run !== undefined
      ? ((run.kind === 'building' ? BUILD_STAGE_LABELS : IMPROVE_STAGE_LABELS)[run.stage] ??
          `${run.stage}…`) + (run.stage === 'writing' && run.files !== undefined ? ` (${run.files} files)` : '')
      : undefined
  const timeline = [...iterations].sort((a, b) => a.v - b.v)

  return (
    <div className="flex flex-col gap-6">
      {/* The idea itself — the product's core object. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{name}</h1>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${pill.tone}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full bg-current ${isRunning ? 'animate-pulse' : ''}`} />
            {pill.label}
          </span>
        </div>

        {isEditingIdea ? (
          <div className="flex flex-col gap-2">
            <textarea
              className="field min-h-[88px] max-w-2xl resize-y"
              value={ideaDraft}
              onChange={(event) => setIdeaDraft(event.target.value)}
              maxLength={2000}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleSaveIdea()}
                disabled={ideaDraft.trim().length === 0 || isSavingIdea}
              >
                {isSavingIdea ? 'Saving…' : 'Save idea'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIdeaDraft(ideaText)
                  setIsEditingIdea(false)
                }}
                disabled={isSavingIdea}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex max-w-2xl flex-col items-start gap-1.5">
            {hasIdeaText ? (
              <p className="text-base leading-relaxed text-fg">{ideaText}</p>
            ) : (
              <p className="text-sm text-muted">
                No idea text yet — write down what this should become. That sentence is what gets
                built.
              </p>
            )}
            <button
              type="button"
              className="text-xs text-faint underline-offset-4 transition-colors hover:text-gold hover:underline"
              onClick={() => {
                setIdeaDraft(ideaText)
                setIsEditingIdea(true)
              }}
              disabled={isRunning}
            >
              {hasIdeaText ? 'Edit idea' : 'Add the idea'}
            </button>
          </div>
        )}

        {!builderReady && (
          <p className="max-w-2xl rounded-md border border-gold/40 bg-gold/5 px-3 py-2 text-sm text-gold/90">
            To build and improve, add <span className="font-mono">ANTHROPIC_API_KEY</span> to the
            repo-root <span className="font-mono">.env</span>.
          </p>
        )}

        {/* One primary action. */}
        <div className="flex flex-wrap items-center gap-3">
          {version === 0 ? (
            <button type="button" className="btn-primary" onClick={() => void handleBuild()} disabled={!canAct}>
              {run?.kind === 'building' ? 'Building…' : 'Build v1'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleImproveOnce()}
                disabled={!canAct || isAutoOn}
              >
                {run?.kind === 'improving' && !isAutoOn ? 'Improving…' : `Improve to v${version + 1}`}
              </button>
              <label
                className={`flex items-center gap-2 text-sm ${
                  builderReady ? 'cursor-pointer text-fg' : 'cursor-not-allowed text-faint'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isAutoOn}
                  onChange={handleAutoToggle}
                  disabled={!builderReady || !hasIdeaText}
                  className="accent-[#d4a54a]"
                />
                Auto-improve
                <span className="font-mono text-[11px] text-faint">
                  {isAutoOn ? `on — ${autoRuns}/${AUTO_MAX_RUNS_PER_SESSION} this session` : 'off'}
                </span>
              </label>
              <button
                type="button"
                className="text-xs text-faint underline-offset-4 transition-colors hover:text-gold hover:underline"
                onClick={() => void handleBuild()}
                disabled={!canAct || isAutoOn}
              >
                Rebuild from scratch
              </button>
            </>
          )}
        </div>

        {isKeepGoingPromptVisible && (
          <div className="flex max-w-2xl items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/5 px-3 py-2">
            <p className="text-sm text-gold/90">
              {AUTO_MAX_RUNS_PER_SESSION} improvements shipped this session. Keep going?
            </p>
            <button type="button" className="btn-primary" onClick={handleKeepGoing}>
              Keep going
            </button>
          </div>
        )}

        {error !== undefined && <p className="max-w-2xl text-sm text-bad">{error}</p>}
      </section>

      {/* The iteration timeline — watch it get better. */}
      <section className="panel p-5">
        <h2 className="section-title mb-4">Every version so far</h2>
        {timeline.length === 0 && run === undefined ? (
          <p className="text-sm text-muted">
            Nothing shipped yet. Hit <span className="text-gold">Build v1</span> and watch this
            feed fill up.
          </p>
        ) : (
          <ol className="flex flex-col">
            {timeline.map((iteration) => (
              <li key={iteration.v} className="flex items-baseline gap-3 border-l border-edge py-2 pl-4">
                <span className="w-9 shrink-0 font-mono text-xs font-medium text-gold">
                  v{iteration.v}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-relaxed text-fg">
                  {iteration.v === 1 ? `Built: ${iteration.summary}` : iteration.summary}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                    iteration.checkPassed
                      ? 'border-good/50 bg-good/10 text-good'
                      : 'border-bad/50 bg-bad/10 text-bad'
                  }`}
                >
                  {iteration.checkPassed ? 'check ✓' : 'check ✗'}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {formatAt(iteration.at)}
                </span>
              </li>
            ))}
            {run !== undefined && stageLabel !== undefined && (
              <li className="flex items-center gap-3 border-l border-gold/40 py-2 pl-4">
                <span className="w-9 shrink-0 font-mono text-xs font-medium text-gold">
                  v{run.targetV}
                </span>
                <span className="flex items-center gap-2 text-sm text-muted">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-gold" />
                  {stageLabel}
                </span>
              </li>
            )}
          </ol>
        )}

        {lastCheck !== undefined && lastCheck.exit_code !== 0 && (
          <div className="mt-4">
            <p className="section-title mb-2">Latest check output</p>
            <pre className="overflow-x-auto rounded-md border border-edge bg-ink p-3 font-mono text-xs text-muted">
              {lastCheck.stdout.trim().length > 0 ? lastCheck.stdout : '(no stdout)'}
              {lastCheck.stderr.trim().length > 0 ? `\n[stderr]\n${lastCheck.stderr}` : ''}
            </pre>
            <p className="mt-2 text-xs text-muted">
              This version's check failed — the next improvement will fix it first.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
