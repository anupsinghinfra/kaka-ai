/**
 * Ideas dashboard (/ideas) — your startup ideas, each with its shipped
 * version and live status (fetched server-side, errors tolerated as
 * "unknown"), plus the new-idea form. Auth-gated by the /ideas layout when
 * Cognito is configured; open in local mode.
 */

import Link from 'next/link'
import { NewIdeaForm } from '@/components/NewIdeaForm'
import { withStatuses } from '@/lib/ideas'
import { currentVersion, listIdeas } from '@/lib/registry'

export const dynamic = 'force-dynamic'

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function versionPill(version: number): { label: string; tone: string } {
  return version === 0
    ? { label: 'draft', tone: 'border-edge bg-raised text-muted' }
    : { label: `v${version}`, tone: 'border-good/50 bg-good/10 text-good' }
}

export default async function DashboardPage() {
  const ideas = await withStatuses(listIdeas())

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Your startup ideas</h1>
        <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
          Type an idea. kaka builds a working v1, proves it runs, then keeps shipping improvements
          — v2, v3, v4 — while you watch.
        </p>
      </section>

      {ideas.length === 0 ? (
        <section className="panel px-8 py-14 text-center">
          <p className="text-xl font-medium text-fg">Every startup starts as one sentence.</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            Type yours below and it becomes a real, running product — built, tested, and then
            improved version after version, on its own. The only thing you have to bring is the
            idea.
          </p>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ideas.map((idea) => {
            const pill = versionPill(currentVersion(idea))
            return (
              <Link
                key={idea.name}
                href={`/ideas/${encodeURIComponent(idea.name)}`}
                className="panel group block p-5 transition-colors hover:border-gold/50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm font-medium text-fg group-hover:text-gold">
                    {idea.name}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${pill.tone}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {pill.label}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 min-h-[1.25rem] text-sm text-muted">
                  {idea.idea ?? <span className="text-faint">No idea text yet — add one.</span>}
                </p>
                <div className="mt-4 flex items-center gap-3 font-mono text-[11px] text-faint">
                  <span>{formatDate(idea.createdAt)}</span>
                  {idea.forkedFrom !== undefined && (
                    <span className="text-gold/70">forked from {idea.forkedFrom}</span>
                  )}
                  <span>{idea.status}</span>
                </div>
              </Link>
            )
          })}
        </section>
      )}

      <NewIdeaForm />
    </div>
  )
}
