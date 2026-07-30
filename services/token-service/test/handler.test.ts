import { constants as cryptoConstants, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { verifyToken } from '@platform/authorizer'
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { TOKEN_ISSUER } from '../src/config'
import { createIssueTokenHandler, type HandlerDependencies } from '../src/handler'
import { KmsJwtSigner } from '../src/kms-signer'
import { DynamoDbPolicyRepository } from '../src/policy-store'
import {
  decodeJwtPart,
  FailingKmsClient,
  FakeDynamoClient,
  FakeKmsClient,
  generateTestKeyPair,
  makeEvent,
  silentLogger,
  testConfig,
  type TestKeyPair
} from './helpers/fakes'

const keys: TestKeyPair = generateTestKeyPair()
const NOW = new Date('2026-07-29T12:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

const BUILDER_POLICY = {
  principalId: 'agent-builder-1',
  allowedScopes: ['fs:fork:venture-42/*', 'fs:write:venture-42/*', 'db:branch:venture-42', 'runtime:preview:venture-42']
}

interface SetupOverrides {
  readonly policies?: Readonly<Record<string, Record<string, unknown>>>
  readonly deps?: Partial<HandlerDependencies>
}

function setup(overrides: SetupOverrides = {}) {
  const kmsClient = new FakeKmsClient(keys)
  const dynamoClient = new FakeDynamoClient(overrides.policies ?? { [BUILDER_POLICY.principalId]: BUILDER_POLICY })
  const signer = new KmsJwtSigner(kmsClient, testConfig().signingKeyId)

  const deps: HandlerDependencies = {
    policies: new DynamoDbPolicyRepository(dynamoClient, testConfig().policiesTableName),
    signer,
    getVerificationKey: () => Promise.resolve(keys.publicKey),
    config: testConfig(),
    logger: silentLogger,
    now: () => NOW,
    ...overrides.deps
  }

  return { handler: createIssueTokenHandler(deps), kmsClient, dynamoClient }
}

function parseBody(result: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  expect(result.body).toBeDefined()
  return JSON.parse(result.body as string) as Record<string, unknown>
}

function expectErrorBody(
  result: APIGatewayProxyStructuredResultV2,
  statusCode: number,
  code: string
): Record<string, unknown> {
  expect(result.statusCode).toBe(statusCode)
  const body = parseBody(result)
  const error = body['error'] as Record<string, unknown>
  expect(error['code']).toBe(code)
  expect(typeof error['message']).toBe('string')
  expect(typeof error['remediation']).toBe('string')
  return error
}

/** Mints a parent token signed by the local test key (as KMS would). */
function mintParentToken(scopes: readonly string[], privateKey: KeyObject, overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: TOKEN_ISSUER,
    sub: 'agent-orchestrator',
    scopes,
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 240,
    jti: 'parent-jti-1',
    ...overrides
  }
  const header = { alg: 'PS256', typ: 'JWT', kid: 'parent-key' }
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST
  })

  return `${signingInput}.${signature.toString('base64url')}`
}

describe('POST /tokens — request validation', () => {
  test('rejects a missing body', async () => {
    // Arrange
    const { handler } = setup()
    const event = makeEvent('')

    // Act
    const result = await handler({ ...event, body: undefined })

    // Assert
    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('rejects invalid JSON', async () => {
    const { handler } = setup()
    const result = await handler(makeEvent('{not json'))
    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('rejects a schema-invalid body (missing scopes)', async () => {
    const { handler } = setup()
    const result = await handler(makeEvent({ principalId: 'agent-builder-1' }))
    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('rejects unknown fields (strict schema)', async () => {
    const { handler } = setup()
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'], admin: true })
    )
    expectErrorBody(result, 400, 'INVALID_REQUEST')
  })

  test('rejects grammar-invalid scopes with INVALID_SCOPE', async () => {
    // Arrange
    const { handler } = setup()

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42', 'fs:write:Venture-42'] })
    )

    // Assert
    const error = expectErrorBody(result, 400, 'INVALID_SCOPE')
    expect(error['message']).toContain('fs:write:Venture-42')
  })

  test('rejects a TTL above the 15-minute maximum', async () => {
    // Arrange
    const { handler } = setup()

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'], ttlSeconds: 901 })
    )

    // Assert
    const error = expectErrorBody(result, 400, 'INVALID_TTL')
    expect(error['message']).toContain('900')
  })

  test('handles base64-encoded bodies', async () => {
    // Arrange
    const { handler } = setup()
    const raw = JSON.stringify({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'] })
    const event = { ...makeEvent(''), body: Buffer.from(raw).toString('base64'), isBase64Encoded: true }

    // Act
    const result = await handler(event)

    // Assert
    expect(result.statusCode).toBe(201)
  })
})

describe('POST /tokens — policy enforcement (deny-by-default)', () => {
  test('denies when the principal has no policy record', async () => {
    // Arrange
    const { handler, dynamoClient } = setup({ policies: {} })

    // Act
    const result = await handler(makeEvent({ principalId: 'agent-unknown', scopes: ['db:branch:venture-42'] }))

    // Assert
    expectErrorBody(result, 403, 'POLICY_NOT_FOUND')
    expect(dynamoClient.getCommands).toHaveLength(1)
    expect(dynamoClient.getCommands[0].input.Key).toEqual({ principalId: 'agent-unknown' })
  })

  test('denies scopes outside the policy and names the offenders', async () => {
    // Arrange
    const { handler } = setup()

    // Act
    const result = await handler(
      makeEvent({
        principalId: 'agent-builder-1',
        scopes: ['runtime:preview:venture-42', 'runtime:promote:venture-42']
      })
    )

    // Assert
    const error = expectErrorBody(result, 403, 'SCOPE_NOT_ALLOWED')
    expect(error['message']).toContain('runtime:promote:venture-42')
    expect(error['message']).not.toContain('runtime:preview:venture-42,')
  })

  test('denies a wildcard request wider than the policy grant', async () => {
    // Arrange: policy allows only one branch, request asks for all branches
    const { handler } = setup({
      policies: { 'agent-narrow': { principalId: 'agent-narrow', allowedScopes: ['fs:write:venture-42/main'] } }
    })

    // Act
    const result = await handler(makeEvent({ principalId: 'agent-narrow', scopes: ['fs:write:venture-42/*'] }))

    // Assert
    expectErrorBody(result, 403, 'SCOPE_NOT_ALLOWED')
  })

  test('fails closed on a malformed policy document', async () => {
    // Arrange
    const { handler } = setup({
      policies: { 'agent-broken': { principalId: 'agent-broken', allowedScopes: 'not-an-array' } }
    })

    // Act
    const result = await handler(makeEvent({ principalId: 'agent-broken', scopes: ['db:branch:venture-42'] }))

    // Assert
    expectErrorBody(result, 403, 'POLICY_INVALID')
  })
})

describe('POST /tokens — attenuation', () => {
  test('denies scopes exceeding the parent token (attenuation-only)', async () => {
    // Arrange: parent only carries preview; child asks for write too
    const { handler } = setup()
    const parentToken = mintParentToken(['runtime:preview:venture-42'], keys.privateKey)

    // Act
    const result = await handler(
      makeEvent({
        principalId: 'agent-builder-1',
        scopes: ['runtime:preview:venture-42', 'fs:write:venture-42/branch-x'],
        parentToken
      })
    )

    // Assert
    const error = expectErrorBody(result, 403, 'ATTENUATION_VIOLATION')
    expect(error['message']).toContain('fs:write:venture-42/branch-x')
  })

  test('rejects an expired parent token', async () => {
    // Arrange
    const { handler } = setup()
    const parentToken = mintParentToken(['runtime:preview:venture-42'], keys.privateKey, {
      iat: NOW_SECONDS - 600,
      exp: NOW_SECONDS - 300
    })

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['runtime:preview:venture-42'], parentToken })
    )

    // Assert
    expectErrorBody(result, 401, 'INVALID_PARENT_TOKEN')
  })

  test('rejects a parent token signed by the wrong key', async () => {
    // Arrange
    const { handler } = setup()
    const wrongKeys = generateTestKeyPair()
    const parentToken = mintParentToken(['runtime:preview:venture-42'], wrongKeys.privateKey)

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['runtime:preview:venture-42'], parentToken })
    )

    // Assert
    expectErrorBody(result, 401, 'INVALID_PARENT_TOKEN')
  })

  test('rejects a parent token with a foreign issuer', async () => {
    // Arrange
    const { handler } = setup()
    const parentToken = mintParentToken(['runtime:preview:venture-42'], keys.privateKey, {
      iss: 'urn:someone-else'
    })

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['runtime:preview:venture-42'], parentToken })
    )

    // Assert
    expectErrorBody(result, 401, 'INVALID_PARENT_TOKEN')
  })

  test('issues when requested scopes narrow the parent (and still satisfy policy)', async () => {
    // Arrange: parent has wildcard write; child narrows to one branch
    const { handler } = setup()
    const parentToken = mintParentToken(['fs:write:venture-42/*', 'runtime:preview:venture-42'], keys.privateKey)

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['fs:write:venture-42/branch-x'], parentToken })
    )

    // Assert
    expect(result.statusCode).toBe(201)
  })

  test('policy still binds even with a permissive parent token', async () => {
    // Arrange: parent grants promote, but the principal policy does not
    const { handler } = setup()
    const parentToken = mintParentToken(['runtime:promote:venture-42'], keys.privateKey)

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['runtime:promote:venture-42'], parentToken })
    )

    // Assert
    expectErrorBody(result, 403, 'SCOPE_NOT_ALLOWED')
  })
})

describe('POST /tokens — issuance (happy path)', () => {
  test('issues a KMS-signed PS256 token with the exact claims', async () => {
    // Arrange
    const { handler, kmsClient } = setup()
    const requestedScopes = ['fs:write:venture-42/branch-x', 'db:branch:venture-42']

    // Act
    const result = await handler(makeEvent({ principalId: 'agent-builder-1', scopes: requestedScopes }))

    // Assert — response envelope
    expect(result.statusCode).toBe(201)
    expect(result.headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store' })
    const body = parseBody(result)
    expect(body['tokenType']).toBe('Bearer')
    expect(body['expiresIn']).toBe(300)
    expect(body['scopes']).toEqual(requestedScopes)
    expect(body['expiresAt']).toBe(new Date((NOW_SECONDS + 300) * 1000).toISOString())

    // Assert — JWT header
    const token = body['token'] as string
    const [headerPart] = token.split('.')
    const header = decodeJwtPart(headerPart)
    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', kid: testConfig().signingKeyId })

    // Assert — KMS was asked to sign with the configured key
    expect(kmsClient.signCommands).toHaveLength(1)
    expect(kmsClient.signCommands[0].input).toMatchObject({
      KeyId: testConfig().signingKeyId,
      SigningAlgorithm: 'RSASSA_PSS_SHA_256',
      MessageType: 'RAW'
    })

    // Assert — the token verifies end-to-end via @platform/authorizer
    const verified = await verifyToken(token, { publicKey: keys.publicKey }, { issuer: TOKEN_ISSUER, now: NOW })
    expect(verified.sub).toBe('agent-builder-1')
    expect(verified.scopes).toEqual(requestedScopes)
    expect(verified.iat).toBe(NOW_SECONDS)
    expect(verified.exp).toBe(NOW_SECONDS + 300)
    expect(verified.jti).toBe(body['jti'])
    expect(verified.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('honors an explicit TTL within the maximum', async () => {
    // Arrange
    const { handler } = setup()

    // Act
    const result = await handler(
      makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'], ttlSeconds: 900 })
    )

    // Assert
    expect(result.statusCode).toBe(201)
    const body = parseBody(result)
    expect(body['expiresIn']).toBe(900)
    const verified = await verifyToken(body['token'] as string, { publicKey: keys.publicKey }, { now: NOW })
    expect(verified.exp - verified.iat).toBe(900)
  })

  test('issues unique jti values per token', async () => {
    // Arrange
    const { handler } = setup()
    const event = makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'] })

    // Act
    const first = parseBody(await handler(event))
    const second = parseBody(await handler(event))

    // Assert
    expect(first['jti']).not.toBe(second['jti'])
  })
})

describe('POST /tokens — internal failures', () => {
  test('maps unexpected errors to a machine-readable 500 without leaking details', async () => {
    // Arrange
    const failingSigner = new KmsJwtSigner(new FailingKmsClient(), testConfig().signingKeyId)
    const { handler } = setup({ deps: { signer: failingSigner } })

    // Act
    const result = await handler(makeEvent({ principalId: 'agent-builder-1', scopes: ['db:branch:venture-42'] }))

    // Assert
    const error = expectErrorBody(result, 500, 'INTERNAL_ERROR')
    expect(error['message']).not.toContain('KMS unavailable')
  })
})
