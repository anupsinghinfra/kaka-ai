/**
 * Venture page — header (status, cell_id, lineage, actions), Builder,
 * Console, Files, Journal, and Snapshots. Data is loaded server-side; the
 * interactive panels call the API routes.
 */

import { notFound } from 'next/navigation'
import { BuildPanel } from '@/components/BuildPanel'
import { ConsolePanel } from '@/components/ConsolePanel'
import { FilesPanel } from '@/components/FilesPanel'
import { JournalPanel } from '@/components/JournalPanel'
import { SnapshotsPanel, type SnapshotView } from '@/components/SnapshotsPanel'
import { StatusBadge } from '@/components/StatusBadge'
import { VentureActions } from '@/components/VentureActions'
import { getOnCell, isBuilderConfigured } from '@/lib/oncell'
import { getVenture } from '@/lib/registry'
import { fetchCellStatus } from '@/lib/ventures'

export const dynamic = 'force-dynamic'

interface VenturePageProps {
  params: Promise<{ name: string }>
}

/** Registry snapshots merged with the cell's remote snapshot list. */
async function mergedSnapshots(
  cellId: string,
  local: readonly SnapshotView[]
): Promise<readonly SnapshotView[]> {
  let remote: readonly SnapshotView[] = []
  try {
    const listed = await getOnCell().listSnapshots(cellId)
    remote = listed.map((snapshot) => ({
      key: snapshot.snapshot_key,
      ...(typeof snapshot.created_at === 'string' ? { at: snapshot.created_at } : {}),
      ...(typeof snapshot.size_bytes === 'number' ? { sizeBytes: snapshot.size_bytes } : {})
    }))
  } catch {
    // Remote listing is best-effort; the registry history still renders.
  }
  const byKey = new Map<string, SnapshotView>()
  for (const snapshot of [...local, ...remote]) {
    byKey.set(snapshot.key, { ...byKey.get(snapshot.key), ...snapshot })
  }
  return [...byKey.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export default async function VenturePage({ params }: VenturePageProps) {
  const { name } = await params
  const venture = getVenture(decodeURIComponent(name))
  if (venture === undefined) {
    notFound()
  }

  const [status, snapshots, builderReady] = await Promise.all([
    fetchCellStatus(venture.cellId),
    mergedSnapshots(venture.cellId, venture.snapshots),
    Promise.resolve(isBuilderConfigured())
  ])

  const hasIdea = venture.idea !== undefined && venture.idea.trim().length > 0

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{venture.name}</h1>
          <StatusBadge status={status} />
        </div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 font-mono text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-faint">cell_id</dt>
            <dd className="truncate text-muted">{venture.cellId}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-faint">created</dt>
            <dd className="text-muted">{formatDate(venture.createdAt)}</dd>
          </div>
          {venture.forkedFrom !== undefined && (
            <div className="flex gap-2">
              <dt className="text-faint">forked from</dt>
              <dd className="text-gold/80">{venture.forkedFrom}</dd>
            </div>
          )}
          {venture.builtAt !== undefined && (
            <div className="flex gap-2">
              <dt className="text-faint">last built</dt>
              <dd className="text-good/80">{formatDate(venture.builtAt)}</dd>
            </div>
          )}
        </dl>
        {hasIdea && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">{venture.idea}</p>
        )}
        <VentureActions name={venture.name} />
      </section>

      <BuildPanel name={venture.name} hasIdea={hasIdea} builderReady={builderReady} />
      <ConsolePanel name={venture.name} />
      <FilesPanel name={venture.name} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <JournalPanel name={venture.name} />
        <SnapshotsPanel name={venture.name} snapshots={snapshots} />
      </div>
    </div>
  )
}
