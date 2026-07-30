/**
 * Venture records in DynamoDB: single table, PK `ventureId`, GSI on
 * `ownerId` (sorted by `createdAt`). Optimistic concurrency via a
 * conditional write on the `version` attribute.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type GetCommandOutput,
  type PutCommandOutput,
  type QueryCommandOutput
} from '@aws-sdk/lib-dynamodb'
import type { VentureManifest } from '@platform/contracts'
import { z } from 'zod'
import { RegistryError } from './errors'
import type { OwnerIndexKey, VenturePage, VentureRecord, VentureRepository } from './types'

type StoreCommand = PutCommand | GetCommand | QueryCommand
type StoreOutput = PutCommandOutput | GetCommandOutput | QueryCommandOutput

/** Minimal structural view of DynamoDBDocumentClient (injectable for tests). */
export interface VentureStoreClient {
  send(command: StoreCommand): Promise<StoreOutput>
}

/**
 * Record shape check on every read — fail closed on corrupt rows rather than
 * serving them. The manifest is not re-validated against the JSON Schema here
 * (it was validated on write); `passthrough` tolerates additive attributes.
 */
const ventureRecordSchema = z
  .object({
    ventureId: z.string().min(1),
    ownerId: z.string().min(1),
    status: z.enum(['active', 'deleted']),
    version: z.number().int().min(1),
    manifest: z.record(z.unknown()),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  })
  .passthrough()

export class DynamoDbVentureRepository implements VentureRepository {
  private readonly client: VentureStoreClient
  private readonly tableName: string
  private readonly ownerIndexName: string

  constructor(client: VentureStoreClient, tableName: string, ownerIndexName: string) {
    this.client = client
    this.tableName = tableName
    this.ownerIndexName = ownerIndexName
  }

  async create(record: VentureRecord): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(record),
          ConditionExpression: 'attribute_not_exists(ventureId)'
        })
      )
    } catch (error: unknown) {
      if (isConditionalCheckFailed(error)) {
        throw new RegistryError(
          'VENTURE_EXISTS',
          409,
          `A venture with id "${record.ventureId}" already exists`,
          'Venture ids are registry-assigned and unique; retry the create to receive a fresh id.'
        )
      }

      throw error
    }
  }

  async findById(ventureId: string): Promise<VentureRecord | null> {
    const output = (await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { ventureId },
        ConsistentRead: true
      })
    )) as GetCommandOutput

    if (output.Item === undefined) {
      return null
    }

    return parseRecord(output.Item)
  }

  async listByOwner(ownerId: string, limit: number, exclusiveStartKey?: OwnerIndexKey): Promise<VenturePage> {
    const output = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: this.ownerIndexName,
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': ownerId },
        Limit: limit,
        // Newest first: the GSI sort key is createdAt.
        ScanIndexForward: false,
        ...(exclusiveStartKey !== undefined ? { ExclusiveStartKey: { ...exclusiveStartKey } } : {})
      })
    )) as QueryCommandOutput

    const ventures = (output.Items ?? []).map((item) => parseRecord(item))
    const lastKey = output.LastEvaluatedKey

    return {
      ventures,
      ...(lastKey !== undefined ? { lastEvaluatedKey: toOwnerIndexKey(lastKey) } : {})
    }
  }

  async replace(record: VentureRecord, expectedVersion: number): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(record),
          ConditionExpression: 'attribute_exists(ventureId) AND #version = :expectedVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expectedVersion': expectedVersion }
        })
      )
    } catch (error: unknown) {
      if (isConditionalCheckFailed(error)) {
        throw new RegistryError(
          'VERSION_CONFLICT',
          409,
          `Venture "${record.ventureId}" was modified concurrently (expected version ${expectedVersion})`,
          'GET the venture to obtain its current version, rebase your change on the current manifest, and retry with that expectedVersion.'
        )
      }

      throw error
    }
  }
}

function toItem(record: VentureRecord): Record<string, unknown> {
  return {
    ventureId: record.ventureId,
    ownerId: record.ownerId,
    status: record.status,
    version: record.version,
    manifest: record.manifest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function parseRecord(item: Record<string, unknown>): VentureRecord {
  const result = ventureRecordSchema.safeParse(item)

  if (!result.success) {
    // Fail closed: never serve a corrupt registry row.
    throw new RegistryError(
      'INTERNAL_ERROR',
      500,
      'A stored venture record is malformed',
      'Report a platform bug; the registry table row must be repaired before this venture is readable.'
    )
  }

  const parsed = result.data

  return {
    ventureId: parsed.ventureId,
    ownerId: parsed.ownerId,
    status: parsed.status,
    version: parsed.version,
    manifest: parsed.manifest as unknown as VentureManifest,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt
  }
}

function toOwnerIndexKey(key: Record<string, unknown>): OwnerIndexKey {
  return {
    ventureId: String(key['ventureId']),
    ownerId: String(key['ownerId']),
    createdAt: String(key['createdAt'])
  }
}

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException'
}
