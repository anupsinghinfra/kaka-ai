/**
 * Dashboard — venture cards with live cell status (fetched server-side,
 * errors tolerated as "unknown") plus the create panel.
 */

import Link from 'next/link'
import { CreateVentureForm } from '@/components/CreateVentureForm'
import { StatusBadge } from '@/components/StatusBadge'
import { listVentures } from '@/lib/registry'
import { withStatuses } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default async function DashboardPage() {
  const ventures = await withStatuses(listVentures())

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Ventures</h1>
        <p className="mt-1 text-sm text-muted">
          Every venture is a live cell — code, files, and state that snapshot and fork as one.
        </p>
      </section>

      {ventures.length === 0 ? (
        <section className="panel px-8 py-14 text-center">
          <p className="text-xl font-medium text-fg">You bring an idea.</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            The platform gives it a cell of its own, builds a working first version, proves it
            runs, and lets you snapshot and fork the whole venture — code, files, and state — like
            a branch. Name your first one below.
          </p>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ventures.map((venture) => (
            <Link
              key={venture.name}
              href={`/ventures/${encodeURIComponent(venture.name)}`}
              className="panel group block p-5 transition-colors hover:border-gold/50"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-sm font-medium text-fg group-hover:text-gold">
                  {venture.name}
                </span>
                <StatusBadge status={venture.status} />
              </div>
              <p className="mt-2 line-clamp-2 min-h-[1.25rem] text-sm text-muted">
                {venture.idea ?? <span className="text-faint">No idea recorded yet.</span>}
              </p>
              <div className="mt-4 flex items-center gap-3 font-mono text-[11px] text-faint">
                <span>{formatDate(venture.createdAt)}</span>
                {venture.forkedFrom !== undefined && (
                  <span className="text-gold/70">forked from {venture.forkedFrom}</span>
                )}
                {venture.builtAt !== undefined && <span className="text-good/70">built</span>}
              </div>
            </Link>
          ))}
        </section>
      )}

      <CreateVentureForm />
    </div>
  )
}
