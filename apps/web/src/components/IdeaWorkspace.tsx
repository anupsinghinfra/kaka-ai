'use client'

/**
 * The idea page's core loop: editable idea text, product status pill, the
 * live product URL (the payoff), one primary action (Build v1 → Improve),
 * the auto-improve toggle, and the iteration timeline. Build and improve
 * stream NDJSON stage events from the API (relayed from the Builder
 * agent's in-cell progress); while a run is active a live activity feed
 * takes over the timeline area so progress dominates. Auto-improve is
 * durable and server-side — the Builder agent schedules its own wakes in
 * OnCell, so the browser can close; the toggle just flips the cell's flag.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { accumulateCost, activityLineText, formatCostTicker } from './activity-feed'
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
  liveUrl?: string
  serviceError?: string
  /** Server-read auto-improve flag from the idea cell's kv (kaka:auto). */
  autoImprove?: boolean
  /** ISO timestamp of the Builder's next self-scheduled wake, when known. */
  nextWakeAt?: string
}

interface CheckView {
  exit_code: number
  stdout: string
  stderr: string
}

interface StreamEvent {
  stage: string
  files?: number
  path?: string
  url?: string
  wakeAt?: string
  /** Runtime activity fields ({stage:"activity"} events from the run feed). */
  op?: string
  summary?: string
  ts?: string
  cost?: number
  durationMs?: number
  result?: {
    iteration?: IterationView
    summary?: string
    files?: string[]
    check?: CheckView
    liveUrl?: string
    serviceError?: string
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

const BUILD_STAGE_LABELS: Record<string, string> = {
  preparing: 'Waking your Builder agent…',
  snapshotting: 'Saving a restore point…',
  generating: 'Your Builder is writing v1…',
  writing: 'Shipping the code into your workspace…',
  verifying: 'Proving it runs…',
  starting: 'Starting your app…'
}

const IMPROVE_STAGE_LABELS: Record<string, string> = {
  preparing: 'Waking your Builder agent…',
  reading: 'Reading the current app…',
  snapshotting: 'Saving a restore point…',
  generating: 'Finding the most valuable improvement…',
  writing: 'Shipping the update…',
  verifying: 'Proving it still runs…',
  starting: 'Starting your app…'
}

interface ActivityLine {
  at: string
  text: string
  /**
   * milestone: the agent's kv-protocol stages (generating/writing/live/…),
   * rendered bolder as section markers. activity: the runtime feed's
   * per-op lines — the feed's bread and butter.
   */
  kind: 'milestone' | 'activity'
}

/** Line styling: activity lines quiet, milestones bold section markers. */
function activityLineTone(line: ActivityLine): string {
  if (line.kind === 'activity') {
    return 'text-muted'
  }
  return line.text.endsWith('✓') ? 'font-semibold text-good' : 'font-semibold text-fg'
}

/** One feed line per stream event — the "watch it happen" narration. */
function feedText(kind: RunKind, event: StreamEvent, targetV: number): string | undefined {
  if (event.stage === 'file') {
    return event.path !== undefined ? `${event.path} ✓` : undefined
  }
  if (event.stage === 'writing') {
    return event.files !== undefined ? `Writing ${event.files} files…` : 'Writing files…'
  }
  if (event.stage === 'live') {
    return event.url !== undefined ? `Live at ${event.url} ↗` : undefined
  }
  if (event.stage === 'scheduled') {
    return event.wakeAt !== undefined
      ? `Next improvement scheduled for ${formatAt(event.wakeAt)}`
      : 'Next improvement scheduled'
  }
  if (event.stage === 'done') {
    return event.result?.serviceError !== undefined
      ? `v${targetV} shipped — but the app did not start`
      : `v${targetV} shipped ✓`
  }
  if (event.stage === 'error') {
    return `Failed: ${event.error?.message ?? 'the run failed'}`
  }
  // Unknown stages (the model sometimes improvises, e.g. "shipped") render
  // verbatim as milestone lines instead of being dropped or decorated.
  return (kind === 'building' ? BUILD_STAGE_LABELS : IMPROVE_STAGE_LABELS)[event.stage] ?? event.stage
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

/** Whole minutes until an ISO timestamp; undefined when past or invalid. */
function minutesUntil(iso: string | undefined): number | undefined {
  if (iso === undefined) {
    return undefined
  }
  const at = new Date(iso).getTime()
  if (Number.isNaN(at) || at <= Date.now()) {
    return undefined
  }
  return Math.max(1, Math.round((at - Date.now()) / 60_000))
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

export function IdeaWorkspace({
  name,
  idea,
  builderReady,
  iterations: initial,
  liveUrl: initialLiveUrl,
  serviceError: initialServiceError,
  autoImprove: initialAutoImprove,
  nextWakeAt: initialNextWakeAt
}: IdeaWorkspaceProps) {
  const router = useRouter()
  const [iterations, setIterations] = useState<readonly IterationView[]>(initial)
  const [run, setRun] = useState<RunState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [lastCheck, setLastCheck] = useState<CheckView | undefined>(undefined)
  const [liveUrl, setLiveUrl] = useState<string | undefined>(initialLiveUrl)
  const [serviceError, setServiceError] = useState<string | undefined>(initialServiceError)
  const [isStartingApp, setIsStartingApp] = useState(false)
  const [activity, setActivity] = useState<readonly ActivityLine[]>([])
  const [runCost, setRunCost] = useState(0)
  const [directionDraft, setDirectionDraft] = useState('')
  const feedRef = useRef<HTMLDivElement | null>(null)

  // Keep the live feed pinned to its newest line.
  useEffect(() => {
    const feed = feedRef.current
    if (feed !== null) {
      feed.scrollTop = feed.scrollHeight
    }
  }, [activity])

  const [isEditingIdea, setIsEditingIdea] = useState(false)
  const [ideaDraft, setIdeaDraft] = useState(idea ?? '')
  const [isSavingIdea, setIsSavingIdea] = useState(false)
  const [ideaText, setIdeaText] = useState(idea ?? '')

  const [isAutoOn, setIsAutoOn] = useState(initialAutoImprove ?? false)
  const [nextWakeAt, setNextWakeAt] = useState<string | undefined>(initialNextWakeAt)
  const [isTogglingAuto, setIsTogglingAuto] = useState(false)

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
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
    if (run?.kind === 'improving') {
      return { label: `improving — v${run.targetV}`, tone: 'border-gold/50 bg-gold/10 text-gold' }
    }
    if (isAutoOn) {
      return { label: 'auto-improving', tone: 'border-gold/50 bg-gold/10 text-gold' }
    }
    if (version === 0) {
      return { label: 'draft', tone: 'border-edge bg-raised text-muted' }
    }
    return { label: `v${version}`, tone: 'border-good/50 bg-good/10 text-good' }
  }

  /** Runs one streamed pass (build or improve). Resolves true on success. */
  async function runStreamedPass(kind: RunKind): Promise<boolean> {
    const targetV = kind === 'building' ? 1 : maxVersionRefSafe() + 1
    // Founder direction rides only on manual improve runs.
    const direction = kind === 'improving' ? directionDraft.trim() : ''
    setError(undefined)
    setLastCheck(undefined)
    setActivity([])
    setRunCost(0)
    setRun({ kind, stage: kind === 'building' ? 'generating' : 'reading', targetV })
    try {
      const endpoint = kind === 'building' ? 'build' : 'improve'
      const response = await fetch(`/api/ideas/${encodeURIComponent(name)}/${endpoint}`, {
        method: 'POST',
        ...(direction.length > 0
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ direction })
            }
          : {})
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as StreamEvent
        const base = body.error?.message ?? `request failed with HTTP ${response.status}`
        setError(body.error?.remediation !== undefined ? `${base} — ${body.error.remediation}` : base)
        return false
      }
      setDirectionDraft('')
      let succeeded = false
      await readNdjsonStream(response, (event) => {
        const at = new Date().toLocaleTimeString('en-US', { hour12: false })
        if (event.stage === 'activity') {
          // Runtime feed line — the glass box's bread and butter.
          setRunCost((previous) => accumulateCost(previous, event.cost))
          setActivity((previous) => [
            ...previous,
            { at, text: activityLineText(event), kind: 'activity' }
          ])
          return
        }
        const line = feedText(kind, event, targetV)
        if (line !== undefined) {
          setActivity((previous) => [...previous, { at, text: line, kind: 'milestone' }])
        }
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
        if (event.stage === 'live') {
          if (event.url !== undefined) {
            setLiveUrl(event.url)
            setServiceError(undefined)
          }
          return
        }
        if (event.stage === 'scheduled') {
          // The Builder parked its next wake — surface it, keep the stage.
          setNextWakeAt(event.wakeAt)
          return
        }
        if (event.stage === 'file') {
          // Feed-only detail: the run stage stays "writing".
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
    if (event.result?.liveUrl !== undefined) {
      setLiveUrl(event.result.liveUrl)
      setServiceError(undefined)
    } else if (event.result?.serviceError !== undefined) {
      setLiveUrl(undefined)
      setServiceError(event.result.serviceError)
    }
    router.refresh()
  }

  /** Retry starting the app service after a failed post-build start. */
  async function handleStartApp(): Promise<void> {
    if (isStartingApp) {
      return
    }
    setIsStartingApp(true)
    setError(undefined)
    try {
      const body = await apiFetch<{ liveUrl: string }>(
        `/api/ideas/${encodeURIComponent(name)}/app/start`,
        { method: 'POST' }
      )
      setLiveUrl(body.liveUrl)
      setServiceError(undefined)
      router.refresh()
    } catch (startError: unknown) {
      setServiceError(describeError(startError))
    } finally {
      setIsStartingApp(false)
    }
  }

  async function handleBuild(): Promise<void> {
    await runStreamedPass('building')
  }

  async function handleImproveOnce(): Promise<void> {
    await runStreamedPass('improving')
  }

  /**
   * Flips the durable auto-improve flag on the idea's cell. The Builder
   * agent reads it after every run and schedules its own next wake — the
   * loop lives server-side in OnCell, never in this browser tab.
   */
  async function handleAutoToggle(): Promise<void> {
    if (isTogglingAuto) {
      return
    }
    const next = isAutoOn ? 'off' : 'on'
    setIsTogglingAuto(true)
    setError(undefined)
    try {
      await apiFetch<{ auto: 'on' | 'off' }>(`/api/ideas/${encodeURIComponent(name)}/auto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto: next })
      })
      setIsAutoOn(next === 'on')
      if (next === 'off') {
        setNextWakeAt(undefined)
      }
    } catch (toggleError: unknown) {
      setError(describeError(toggleError))
    } finally {
      if (isMountedRef.current) {
        setIsTogglingAuto(false)
      }
    }
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

        {/* THE PAYOFF: the live product URL, huge and unmissable. */}
        {liveUrl !== undefined ? (
          <div className="flex max-w-2xl flex-col gap-2.5 rounded-lg border border-gold/60 bg-gold/10 p-4">
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary self-start px-6 py-3 text-lg font-semibold"
            >
              Open your product ↗
            </a>
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all font-mono text-sm text-gold underline-offset-4 hover:underline"
            >
              {liveUrl}
            </a>
          </div>
        ) : version === 0 ? (
          <p className="text-xs text-faint">
            Your product&apos;s URL appears here when v1 ships.
          </p>
        ) : (
          serviceError === undefined &&
          !isRunning && (
            <div className="flex max-w-2xl flex-wrap items-center gap-3">
              <p className="text-xs text-faint">Your product isn&apos;t running right now.</p>
              <button
                type="button"
                className="btn"
                onClick={() => void handleStartApp()}
                disabled={isStartingApp}
              >
                {isStartingApp ? 'Starting…' : 'Start app'}
              </button>
            </div>
          )
        )}

        {serviceError !== undefined && (
          <div className="flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/5 px-3 py-2">
            <p className="min-w-0 flex-1 text-sm text-gold/90">
              The app isn&apos;t running: {serviceError}
            </p>
            <button
              type="button"
              className="btn shrink-0"
              onClick={() => void handleStartApp()}
              disabled={isStartingApp || isRunning}
            >
              {isStartingApp ? 'Starting…' : 'Start app'}
            </button>
          </div>
        )}

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
            To build and improve, add <span className="font-mono">ONCELL_API_KEY</span> (or{' '}
            <span className="font-mono">ANTHROPIC_API_KEY</span> with{' '}
            <span className="font-mono">KAKA_BUILDER_MODE=local</span>) to the repo-root{' '}
            <span className="font-mono">.env</span>.
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
              <input
                type="text"
                className="field min-w-0 flex-1 basis-64 py-1.5 text-sm"
                placeholder="Tell it what to ship next — optional; leave empty and the agent picks"
                value={directionDraft}
                onChange={(event) => setDirectionDraft(event.target.value)}
                maxLength={500}
                disabled={!canAct || isAutoOn}
                aria-label="Direction for the next improvement"
              />
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
                  onChange={() => void handleAutoToggle()}
                  disabled={!builderReady || !hasIdeaText || isTogglingAuto || isRunning}
                  className="accent-[#d4a54a]"
                />
                Auto-improve
                <span className="font-mono text-[11px] text-faint">
                  {isAutoOn
                    ? minutesUntil(nextWakeAt) !== undefined
                      ? `improving on its own — next wake ~${minutesUntil(nextWakeAt)}m`
                      : 'improving on its own'
                    : 'off'}
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

        {error !== undefined && <p className="max-w-2xl text-sm text-bad">{error}</p>}
      </section>

      {/* While a run is active, a live activity feed takes over this panel;
          otherwise it is the iteration timeline — watch it get better. */}
      <section className="panel p-5">
        {run !== undefined ? (
          <>
            <h2 className="section-title mb-4 flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-gold" />
              {run.kind === 'building' ? 'Building v1 — live' : `Improving to v${run.targetV} — live`}
              {formatCostTicker(runCost) !== undefined && (
                <span className="ml-auto font-mono text-[11px] font-normal normal-case text-faint">
                  {formatCostTicker(runCost)}
                </span>
              )}
            </h2>
            <div
              ref={feedRef}
              className="max-h-80 overflow-y-auto rounded-md border border-gold/30 bg-ink p-3 font-mono text-xs leading-relaxed"
            >
              <ol className="flex flex-col gap-1">
                {activity.map((line, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="shrink-0 text-faint">{line.at}</span>
                    <span className={activityLineTone(line)}>{line.text}</span>
                  </li>
                ))}
              </ol>
              {stageLabel !== undefined && (
                <p className="mt-2 flex items-center gap-2 text-gold">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                  {stageLabel}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 className="section-title mb-4">Every version so far</h2>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing shipped yet. Hit <span className="text-gold">Build v1</span> and watch this
                feed fill up.
              </p>
            ) : (
              <ol className="flex flex-col">
                {timeline.map((iteration) => (
                  <li
                    key={iteration.v}
                    className="flex items-baseline gap-3 border-l border-edge py-2 pl-4"
                  >
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
              </ol>
            )}
          </>
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
