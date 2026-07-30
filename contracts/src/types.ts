/**
 * Hand-written TypeScript mirrors of the JSON Schemas in this package.
 * Keep in sync with `venture/venture.schema.json` and
 * `events/envelope.schema.json` — the schemas are the source of truth.
 */

export type DatabaseProvider = 'embedded' | 'postgres'

export type DeploymentKind = 'preview' | 'prod'

export interface SpecRef {
  /** Repo-relative path to the living spec document. */
  readonly ref: string
}

export interface RepoRef {
  /** FileSystem primitive repo identifier. */
  readonly ref: string
  readonly defaultBranch?: string
}

export interface DatabaseRef {
  /** Database primitive instance identifier. */
  readonly ref: string
  readonly provider: DatabaseProvider
}

export interface Deployment {
  readonly deployId: string
  readonly kind: DeploymentKind
  /** FileSystem branch/commit ref this deployment serves. */
  readonly codeRef: string
  /** Database branch backing this deployment. */
  readonly dbBranchRef: string
  readonly url: string
}

export interface VentureBudgets {
  /** Total monthly spend ceiling in USD. */
  readonly monthlyUsd: number
  /** Optional per-primitive monthly ceilings in USD, keyed by primitive name. */
  readonly perPrimitive?: Readonly<Record<string, number>>
}

/** venture.yaml v0 — see `venture/venture.schema.json`. */
export interface VentureManifest {
  readonly schemaVersion: '0'
  readonly ventureId: string
  readonly name: string
  readonly spec: SpecRef
  readonly repo: RepoRef
  readonly db: DatabaseRef
  readonly deployments: readonly Deployment[]
  readonly budgets: VentureBudgets
}

/** Envelope for every event on the platform bus — see `events/envelope.schema.json`. */
export interface EventEnvelope<TPayload extends object = Record<string, unknown>> {
  /** Globally unique event ID (UUID). */
  readonly id: string
  /** Dot-delimited event type, e.g. `venture.created`. */
  readonly type: string
  /** Venture the event belongs to; `platform` for platform-level events. */
  readonly ventureId: string
  /** RFC 3339 / ISO 8601 UTC timestamp. */
  readonly timestamp: string
  /** Emitting component, e.g. `registry`. */
  readonly source: string
  readonly payload: TPayload
}
