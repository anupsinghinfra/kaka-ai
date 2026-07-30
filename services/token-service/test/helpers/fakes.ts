/**
 * Test doubles: a fake KMS client that signs with a local node:crypto keypair
 * and a fake DynamoDB document client backed by an in-memory map — the mocked
 * client boundary is exactly the AWS SDK `send(command)` surface.
 */

import {
  constants as cryptoConstants,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject
} from 'node:crypto'
import {
  GetPublicKeyCommand,
  SignCommand,
  type GetPublicKeyCommandOutput,
  type SignCommandOutput
} from '@aws-sdk/client-kms'
import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import pino from 'pino'
import type { ServiceConfig } from '../../src/config'
import type { KmsSigningClient } from '../../src/kms-signer'
import type { PolicyStoreClient } from '../../src/policy-store'

export interface TestKeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKey, privateKey }
}

/**
 * Fake KMS: implements Sign (RSASSA_PSS_SHA_256, RAW message) and
 * GetPublicKey against a local keypair, recording every command.
 */
export class FakeKmsClient implements KmsSigningClient {
  readonly signCommands: SignCommand[] = []
  private readonly keys: TestKeyPair

  constructor(keys: TestKeyPair) {
    this.keys = keys
  }

  send(command: SignCommand | GetPublicKeyCommand): Promise<SignCommandOutput | GetPublicKeyCommandOutput> {
    if (command instanceof SignCommand) {
      this.signCommands.push(command)
      const message = command.input.Message

      if (message === undefined) {
        return Promise.reject(new Error('FakeKmsClient: Sign requires a Message'))
      }

      if (command.input.MessageType === 'DIGEST') {
        // A real HSM signs a prehashed digest directly; node:crypto cannot,
        // so digest-mode fakes return a fixed placeholder signature. Tests
        // that need a verifiable signature stay under the RAW size limit.
        return Promise.resolve({
          Signature: Buffer.from('digest-mode-placeholder-signature'),
          $metadata: {}
        })
      }

      const signature = cryptoSign('sha256', Buffer.from(message), {
        key: this.keys.privateKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST
      })

      return Promise.resolve({ Signature: signature, $metadata: {} })
    }

    const der = this.keys.publicKey.export({ type: 'spki', format: 'der' })
    return Promise.resolve({ PublicKey: new Uint8Array(der), $metadata: {} })
  }
}

/** Fake KMS whose Sign always fails — for internal-error paths. */
export class FailingKmsClient implements KmsSigningClient {
  send(): Promise<SignCommandOutput | GetPublicKeyCommandOutput> {
    return Promise.reject(new Error('KMS unavailable'))
  }
}

/** Fake DynamoDB document client: in-memory items keyed by principalId. */
export class FakeDynamoClient implements PolicyStoreClient {
  readonly getCommands: GetCommand[] = []
  private readonly items: ReadonlyMap<string, Record<string, unknown>>

  constructor(items: Readonly<Record<string, Record<string, unknown>>>) {
    this.items = new Map(Object.entries(items))
  }

  send(command: GetCommand): Promise<GetCommandOutput> {
    this.getCommands.push(command)
    const key = command.input.Key?.['principalId']
    const item = typeof key === 'string' ? this.items.get(key) : undefined

    return Promise.resolve({
      ...(item !== undefined ? { Item: { ...item } } : {}),
      $metadata: {}
    })
  }
}

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    policiesTableName: 'policies-test',
    signingKeyId: 'arn:aws:kms:us-east-1:111111111111:key/test-key-id',
    defaultTtlSeconds: 300,
    maxTtlSeconds: 900,
    logLevel: 'silent',
    ...overrides
  }
}

export const silentLogger = pino({ level: 'silent' })

/** Builds a minimal API Gateway HTTP API v2 event carrying the given body. */
export function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  const event = {
    version: '2.0',
    routeKey: 'POST /tokens',
    rawPath: '/tokens',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { requestId: 'test-request-id' },
    isBase64Encoded: false,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }

  return event as unknown as APIGatewayProxyEventV2
}

/** Decodes a base64url JSON JWT part. */
export function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}
