/**
 * Public landing page (/) — server-rendered marketing for the MVP loop:
 * type an idea, kaka builds and proves v1, then ships v2, v3, v4 on its
 * own. "Start building" goes to /login when Cognito is configured (an
 * already-signed-in visitor is forwarded straight to /ideas by /login) and
 * directly to /ideas in local mode.
 */

import Link from 'next/link'
import { isAuthConfigured, startBuildingHref } from '@/lib/auth/config'
import { loadRepoEnv } from '@/lib/env'

export const dynamic = 'force-dynamic'

interface Step {
  readonly n: string
  readonly title: string
  readonly body: string
}

const STEPS: readonly Step[] = [
  {
    n: '1',
    title: 'Type the idea',
    body: 'One sentence is enough. No spec, no wireframes, no tech decisions — the idea is the only input.'
  },
  {
    n: '2',
    title: 'AI agents build and prove v1',
    body: 'An agent writes real code — not a template — runs it, and checks it actually works before calling it version one.'
  },
  {
    n: '3',
    title: 'They keep shipping on their own',
    body: 'Each iteration, an agent picks the single most valuable improvement, builds it, verifies it, and logs it — v2, v3, v4 while you watch.'
  }
]

interface TimelineEntry {
  readonly version: string
  readonly summary: string
  readonly state: 'passed' | 'building'
}

const TIMELINE: readonly TimelineEntry[] = [
  { version: 'v1', summary: 'Working product — core flow, pages, and data wired up', state: 'passed' },
  { version: 'v2', summary: 'Sharper onboarding — first run now lands in the product', state: 'passed' },
  { version: 'v3', summary: 'Faster loads — trimmed the critical path render', state: 'passed' },
  { version: 'v4', summary: 'Self-serve settings page', state: 'building' }
]

function TimelineMock() {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <span className="section-title">Iteration timeline</span>
        <span className="font-mono text-[11px] text-faint">improving on its own</span>
      </div>
      <ul className="divide-y divide-edge">
        {TIMELINE.map((entry) => (
          <li key={entry.version} className="flex items-center gap-4 px-5 py-3.5">
            <span className="w-8 shrink-0 font-mono text-sm font-medium text-gold">
              {entry.version}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted">{entry.summary}</span>
            {entry.state === 'passed' ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-good/50 bg-good/10 px-2.5 py-0.5 font-mono text-[11px] text-good">
                ✓ check passed
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-raised px-2.5 py-0.5 font-mono text-[11px] text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                building
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function LandingPage() {
  loadRepoEnv()
  const startHref = startBuildingHref(isAuthConfigured())

  return (
    <div className="flex flex-col gap-20 pb-10">
      <section className="flex flex-col items-start gap-6 pt-8">
        <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          You bring the startup idea. <span className="text-gold">AI agents build it.</span> And
          they never stop improving it.
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-muted">
          Type one sentence. A team of AI agents writes a real, working product, proves it runs,
          and keeps shipping verified improvements — v2, v3, v4 — while you watch. Real code.
          Checked every version. Yours.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={startHref} className="btn-primary px-5 py-2.5 text-base">
            Start building
          </Link>
          <a href="#how-it-works" className="btn px-5 py-2.5 text-base">
            How it works
          </a>
        </div>
      </section>

      <section id="how-it-works" className="flex flex-col gap-6">
        <h2 className="section-title">How it works</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className="panel flex flex-col gap-3 p-6">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-gold/50 bg-gold/10 font-mono text-sm text-gold">
                {step.n}
              </span>
              <h3 className="text-base font-medium text-fg">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">An AI team, not a template.</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
            Every version is one improvement an agent chose, built, ran, and checked before it
            shipped — with a restore point saved first, so nothing is ever lost. This is what an
            idea looks like a few iterations in.
          </p>
        </div>
        <TimelineMock />
        <div>
          <Link href={startHref} className="btn-primary px-5 py-2.5 text-base">
            Start building
          </Link>
        </div>
      </section>
    </div>
  )
}
