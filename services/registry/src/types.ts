/**
 * Shared types for the registry service: the stored venture record, the
 * repository contract, response bodies, and handler dependencies.
 */

import type { VentureManifest } from '@platform/contracts'
import type { PublicKeyInput } from '@platform/authorizer'
import type { EventPublisher } from '@platform/events'
import type { Logger } from './logging'

export type VentureStatus = 'active' | 'deleted'

/** One venture row in the registry table (PK `ventureId`, GSI on `ownerId`). */
export interface VentureRecord {
  readonly ventureId: string
  readonly ownerId: string
  readonly status: VentureStatus
  /** Optimistic-concurrency counter; bumped on every mutation. */
  readonly version: number
  readonly manifest: VentureManifest
  readonly createdAt: string
  readonly updatedAt: string
}

/** GSI key of a row, used as the opaque pagination cursor's payload. */
export interface OwnerIndexKey {
  readonly ventureId: string
  readonly ownerId: string
  readonly createdAt: string
}

export interface VenturePage {
  readonly ventures: readonly VentureRecord[]
  readonly lastEvaluatedKey?: OwnerIndexKey
}

export interface VentureRepository {
  /** Inserts a new record; throws `VENTURE_EXISTS` (409) if the id is taken. */
  create(record: VentureRecord): Promise<void>
  findById(ventureId: string): Promise<VentureRecord | null>
  /** Newest-first page of the owner's ventures via the ownerId GSI. */
  listByOwner(ownerId: string, limit: number, exclusiveStartKey?: OwnerIndexKey): Promise<VenturePage>
  /**
   * Conditionally replaces the record (optimistic concurrency): the write
   * succeeds only if the stored `version` still equals `expectedVersion`.
   * Throws `VERSION_CONFLICT` (409) otherwise.
   */
  replace(record: VentureRecord, expectedVersion: number): Promise<void>
}

/**
 * Non-fatal problems the caller must know about — today only the
 * mutation-succeeded-but-event-unpublished case (see `event-publish.ts`).
 */
export interface ResponseWarning {
  readonly code: 'EVENT_NOT_PUBLISHED'
  readonly message: string
}

export interface VentureResponseBody {
  readonly venture: VentureRecord
  readonly warnings?: readonly ResponseWarning[]
}

export interface VentureListResponseBody {
  readonly ventures: readonly VentureRecord[]
  readonly nextCursor?: string
}

export interface HandlerDependencies {
  readonly ventures: VentureRepository
  readonly publisher: EventPublisher
  /** Verification key for capability tokens (cached KMS GetPublicKey in prod). */
  readonly getVerificationKey: () => Promise<PublicKeyInput>
  readonly logger: Logger
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
  /** Injectable id generator for deterministic tests. */
  readonly generateVentureId?: () => string
}
