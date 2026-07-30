/**
 * Test doubles at the AWS SDK `send(command)` boundary: an in-memory
 * DynamoDB document client honoring the exact conditional expressions the
 * store issues, an EventBridge fake recording PutEvents entries, a KMS fake
 * serving a local keypair, plus local capability-JWT minting (same pattern
 * as libs/authorizer test helpers).
 */

import {
  constants as cryptoConstants,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject
} from 'node:crypto'
import {
  GetPublicKeyCommand,
  type GetPublicKeyCommandOutput
} from '@aws-sdk/client-kms'
import {
  PutEventsCommand,
  type PutEventsCommandOutput
} from '@aws-sdk/client-eventbridge'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type GetCommandOutput,
  type PutCommandOutput,
  type QueryCommandOutput
} from '@aws-sdk/lib-dynamodb'
import type { EventEnvelope } from '@platform/contracts'
import type { EventBridgePutEventsClient } from '@platform/events'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import pino from 'pino'
import { TOKEN_ISSUER } from '../../src/config'
import type { KmsPublicKeyClient } from '../../src/key-resolver'
import type { VentureStoreClient } from '../../src/venture-store'

export const silentLogger = pino({ level: 'silent' })

// ---------------------------------------------------------------------------
// Keys and capability-token minting
// ---------------------------------------------------------------------------

export interface TestKeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKey, privateKey }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export interface MintTokenOptions {
  readonly scopes: readonly string[]
  readonly privateKey: KeyObject
  readonly sub?: string
  readonly claimOverrides?: Readonly<Record<string, unknown>>
}

/** Mints a PS256 capability JWT with a local key, as the token service would. */
export function mintCapabilityToken({ scopes, privateKey, sub, claimOverrides }: MintTokenOptions): string {
  const iat = nowSeconds()
  const payload: Record<string, unknown> = {
    iss: TOKEN_ISSUER,
    sub: sub ?? 'agent-orchestrator-1',
    scopes,
    iat,
    exp: iat + 300,
    jti: 'test-jti-0001',
    ...claimOverrides
  }

  const header = { alg: 'PS256', typ: 'JWT', kid: 'test-signing-key' }
  const encode = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST
  })

  return `${signingInput}.${signature.toString('base64url')}`
}

// ---------------------------------------------------------------------------
// DynamoDB fake
// ---------------------------------------------------------------------------

type StoreCommand = PutCommand | GetCommand | QueryCommand
type StoreOutput = PutCommandOutput | GetCommandOutput | QueryCommandOutput

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed')
  error.name = 'ConditionalCheckFailedException'
  return error
}

/**
 * In-memory ventures table + ownerId GSI. Evaluates exactly the conditional
 * expressions `DynamoDbVentureRepository` issues (attribute_not_exists on
 * create; attribute_exists + version equality on replace).
 */
export class FakeVenturesDynamoClient implements VentureStoreClient {
  readonly items = new Map<string, Record<string, unknown>>()

  send(command: StoreCommand): Promise<StoreOutput> {
    if (command instanceof PutCommand) {
      return this.handlePut(command)
    }

    if (command instanceof GetCommand) {
      return this.handleGet(command)
    }

    return this.handleQuery(command)
  }

  /** Seeds a row directly (bypasses conditions), for test arrangement. */
  seed(item: Record<string, unknown>): void {
    this.items.set(String(item['ventureId']), { ...item })
  }

  private handlePut(command: PutCommand): Promise<PutCommandOutput> {
    const item = command.input.Item as Record<string, unknown>
    const ventureId = String(item['ventureId'])
    const condition = command.input.ConditionExpression ?? ''
    const existing = this.items.get(ventureId)

    if (condition.includes('attribute_not_exists') && existing !== undefined) {
      return Promise.reject(conditionalCheckFailed())
    }

    if (condition.includes('attribute_exists')) {
      const expectedVersion = command.input.ExpressionAttributeValues?.[':expectedVersion']

      if (existing === undefined || existing['version'] !== expectedVersion) {
        return Promise.reject(conditionalCheckFailed())
      }
    }

    this.items.set(ventureId, { ...item })
    return Promise.resolve({ $metadata: {} })
  }

  private handleGet(command: GetCommand): Promise<GetCommandOutput> {
    const key = command.input.Key?.['ventureId']
    const item = typeof key === 'string' ? this.items.get(key) : undefined

    return Promise.resolve({
      ...(item !== undefined ? { Item: { ...item } } : {}),
      $metadata: {}
    })
  }

  private handleQuery(command: QueryCommand): Promise<QueryCommandOutput> {
    const ownerId = command.input.ExpressionAttributeValues?.[':ownerId']
    const limit = command.input.Limit ?? Number.MAX_SAFE_INTEGER
    const startKey = command.input.ExclusiveStartKey

    // Newest-first by createdAt (the GSI sort key), ventureId as tiebreaker.
    const matches = [...this.items.values()]
      .filter((item) => item['ownerId'] === ownerId)
      .sort((left, right) => {
        const byCreatedAt = String(right['createdAt']).localeCompare(String(left['createdAt']))
        return byCreatedAt !== 0 ? byCreatedAt : String(right['ventureId']).localeCompare(String(left['ventureId']))
      })

    const startIndex =
      startKey !== undefined
        ? matches.findIndex((item) => item['ventureId'] === startKey['ventureId']) + 1
        : 0

    const pageItems = matches.slice(startIndex, startIndex + limit)
    const lastReturned = pageItems[pageItems.length - 1]
    const hasMore = startIndex + limit < matches.length

    return Promise.resolve({
      Items: pageItems.map((item) => ({ ...item })),
      ...(hasMore && lastReturned !== undefined
        ? {
            LastEvaluatedKey: {
              ventureId: lastReturned['ventureId'],
              ownerId: lastReturned['ownerId'],
              createdAt: lastReturned['createdAt']
            }
          }
        : {}),
      $metadata: {}
    })
  }
}

// ---------------------------------------------------------------------------
// EventBridge fakes
// ---------------------------------------------------------------------------

/** Records every PutEvents call and accepts all entries. */
export class FakeEventBridgeClient implements EventBridgePutEventsClient {
  readonly commands: PutEventsCommand[] = []

  send(command: PutEventsCommand): Promise<PutEventsCommandOutput> {
    this.commands.push(command)
    const entries = command.input.Entries ?? []

    return Promise.resolve({
      FailedEntryCount: 0,
      Entries: entries.map((_, index) => ({ EventId: `event-${index}` })),
      $metadata: {}
    })
  }

  /** Every published envelope, parsed from entry Detail. */
  get envelopes(): readonly EventEnvelope[] {
    return this.commands.flatMap((command) =>
      (command.input.Entries ?? []).map((entry) => JSON.parse(entry.Detail ?? '{}') as EventEnvelope)
    )
  }
}

/** EventBridge whose PutEvents always fails — for the warnings path. */
export class FailingEventBridgeClient implements EventBridgePutEventsClient {
  send(): Promise<PutEventsCommandOutput> {
    return Promise.reject(new Error('EventBridge unavailable'))
  }
}

// ---------------------------------------------------------------------------
// KMS fake (GetPublicKey only — the registry never signs)
// ---------------------------------------------------------------------------

export class FakeKmsClient implements KmsPublicKeyClient {
  readonly getPublicKeyCommands: GetPublicKeyCommand[] = []
  private readonly publicKey: KeyObject

  constructor(publicKey: KeyObject) {
    this.publicKey = publicKey
  }

  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput> {
    this.getPublicKeyCommands.push(command)
    const der = this.publicKey.export({ type: 'spki', format: 'der' })
    return Promise.resolve({ PublicKey: new Uint8Array(der), $metadata: {} })
  }
}

export class FailingKmsClient implements KmsPublicKeyClient {
  send(): Promise<GetPublicKeyCommandOutput> {
    return Promise.reject(new Error('KMS unavailable'))
  }
}

// ---------------------------------------------------------------------------
// API Gateway HTTP API v2 events
// ---------------------------------------------------------------------------

export interface MakeEventOptions {
  readonly routeKey: string
  readonly token?: string
  readonly body?: unknown
  readonly pathParameters?: Readonly<Record<string, string>>
  readonly queryStringParameters?: Readonly<Record<string, string>>
}

/** Builds a minimal API Gateway HTTP API v2 event for a registry route. */
export function makeEvent(options: MakeEventOptions): APIGatewayProxyEventV2 {
  const [method, path] = options.routeKey.split(' ')

  const event = {
    version: '2.0',
    routeKey: options.routeKey,
    rawPath: path,
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {})
    },
    requestContext: { requestId: 'test-request-id', http: { method } },
    isBase64Encoded: false,
    ...(options.pathParameters !== undefined ? { pathParameters: { ...options.pathParameters } } : {}),
    ...(options.queryStringParameters !== undefined
      ? { queryStringParameters: { ...options.queryStringParameters } }
      : {}),
    ...(options.body !== undefined
      ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }
      : {})
  }

  return event as unknown as APIGatewayProxyEventV2
}

// ---------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------

/** A schema-valid manifest body *without* ventureId (as sent to POST /ventures). */
export function validManifestInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: '0',
    name: 'Test Venture',
    spec: { ref: 'docs/spec.md' },
    repo: { ref: 'repo-test-venture', defaultBranch: 'main' },
    db: { ref: 'db-test-venture', provider: 'embedded' },
    deployments: [],
    budgets: { monthlyUsd: 100 },
    ...overrides
  }
}

/** A full schema-valid manifest for an existing venture. */
export function validManifest(ventureId: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...validManifestInput(overrides), ventureId }
}
