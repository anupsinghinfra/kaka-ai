/**
 * Idea page — a single focused narrative: the idea (editable), product
 * status, one primary action, and the iteration timeline. The operational
 * panels (console, files, journal, snapshots) live in a collapsed "Under
 * the hood" section. Data is loaded server-side; the workspace and panels
 * call the API routes.
 */

import { notFound } from 'next/navigation'
import { ConsolePanel } from '@/components/ConsolePanel'
import { FilesPanel } from '@/components/FilesPanel'
import { IdeaActions } from '@/components/IdeaActions'
import { IdeaWorkspace } from '@/components/IdeaWorkspace'
import { JournalPanel } from '@/components/JournalPanel'
import { SnapshotsPanel, type SnapshotView } from '@/components/SnapshotsPanel'
import { StatusBadge } from '@/components/StatusBadge'
import { UnderTheHood } from '@/components/UnderTheHood'
import { fetchCellStatus } from '@/lib/ideas'
import { getOnCell, isBuilderConfigured } from '@/lib/oncell'
import { getIdea } from '@/lib/registry'

export const dynamic = 'force-dynamic'

interface IdeaPageProps {
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

export default async function IdeaPage({ params }: IdeaPageProps) {
  const { name } = await params
  const idea = getIdea(decodeURIComponent(name))
  if (idea === undefined) {
    notFound()
  }

  const [status, snapshots, builderReady] = await Promise.all([
    fetchCellStatus(idea.cellId),
    mergedSnapshots(idea.cellId, idea.snapshots),
    Promise.resolve(isBuilderConfigured())
  ])

  return (
    <div className="flex flex-col gap-8">
      <IdeaWorkspace
        name={idea.name}
        {...(idea.idea !== undefined ? { idea: idea.idea } : {})}
        builderReady={builderReady}
        iterations={idea.iterations.map((iteration) => ({
          v: iteration.v,
          summary: iteration.summary,
          at: iteration.at,
          checkPassed: iteration.checkPassed
        }))}
      />

      <UnderTheHood>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={status} />
            <dl className="flex flex-wrap gap-x-8 gap-y-1.5 font-mono text-xs">
              <div className="flex gap-2">
                <dt className="text-faint">cell_id</dt>
                <dd className="truncate text-muted">{idea.cellId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-faint">created</dt>
                <dd className="text-muted">{formatDate(idea.createdAt)}</dd>
              </div>
              {idea.forkedFrom !== undefined && (
                <div className="flex gap-2">
                  <dt className="text-faint">forked from</dt>
                  <dd className="text-gold/80">{idea.forkedFrom}</dd>
                </div>
              )}
              {idea.builtAt !== undefined && (
                <div className="flex gap-2">
                  <dt className="text-faint">last built</dt>
                  <dd className="text-good/80">{formatDate(idea.builtAt)}</dd>
                </div>
              )}
            </dl>
          </div>
          <IdeaActions name={idea.name} />
        </div>
        <ConsolePanel name={idea.name} />
        <FilesPanel name={idea.name} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <JournalPanel name={idea.name} />
          <SnapshotsPanel name={idea.name} snapshots={snapshots} />
        </div>
      </UnderTheHood>
    </div>
  )
}
