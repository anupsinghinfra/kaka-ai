import { AuthorizationError, requireScope, verifyToken, type VerifiedToken } from '../src/index'
import {
  generateEcKeyPair,
  generateRsaKeyPair,
  mintToken,
  nowSeconds,
  standardClaims
} from './helpers/local-jwt'

const rsaKeys = generateRsaKeyPair()
const otherRsaKeys = generateRsaKeyPair()
const ecKeys = generateEcKeyPair()

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<AuthorizationError> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuthorizationError)
    const authError = error as AuthorizationError
    expect(authError.code).toBe(code)
    expect(authError.remediation.length).toBeGreaterThan(0)
    return authError
  }

  throw new Error(`expected AuthorizationError(${code}) but the promise resolved`)
}

describe('verifyToken', () => {
  test('verifies a valid PS256 token and returns its claims', async () => {
    // Arrange
    const claims = standardClaims()
    const token = mintToken({ payload: claims, privateKey: rsaKeys.privateKey, kid: 'key-1' })

    // Act
    const verified = await verifyToken(token, { publicKey: rsaKeys.publicKey })

    // Assert
    expect(verified.sub).toBe('agent-builder-1')
    expect(verified.scopes).toEqual(['fs:write:venture-42/branch-x', 'db:branch:venture-42'])
    expect(verified.iat).toBe(claims['iat'])
    expect(verified.exp).toBe(claims['exp'])
    expect(verified.jti).toBe('test-jti-0001')
    expect(verified.kid).toBe('key-1')
    expect(Object.isFrozen(verified)).toBe(true)
  })

  test('verifies a valid ES256 token', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: ecKeys.privateKey, alg: 'ES256' })

    // Act
    const verified = await verifyToken(token, { publicKey: ecKeys.publicKey })

    // Assert
    expect(verified.sub).toBe('agent-builder-1')
  })

  test('accepts an SPKI PEM string as the public key', async () => {
    // Arrange
    const pem = rsaKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const token = mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey })

    // Act
    const verified = await verifyToken(token, { publicKey: pem })

    // Assert
    expect(verified.jti).toBe('test-jti-0001')
  })

  test('resolves the key via getPublicKey with the token kid', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey, kid: 'signing-key-7' })
    const seenKids: Array<string | undefined> = []

    // Act
    const verified = await verifyToken(token, {
      getPublicKey: (kid) => {
        seenKids.push(kid)
        return Promise.resolve(rsaKeys.publicKey)
      }
    })

    // Assert
    expect(verified.sub).toBe('agent-builder-1')
    expect(seenKids).toEqual(['signing-key-7'])
  })

  test('rejects an expired token', async () => {
    // Arrange
    const iat = nowSeconds() - 600
    const token = mintToken({
      payload: standardClaims({ iat, exp: iat + 60 }),
      privateKey: rsaKeys.privateKey
    })

    // Act + Assert
    await expectAuthError(verifyToken(token, { publicKey: rsaKeys.publicKey }), 'TOKEN_EXPIRED')
  })

  test('honors clock tolerance for a just-expired token', async () => {
    // Arrange
    const iat = nowSeconds() - 305
    const token = mintToken({
      payload: standardClaims({ iat, exp: iat + 300 }),
      privateKey: rsaKeys.privateKey
    })

    // Act
    const verified = await verifyToken(token, { publicKey: rsaKeys.publicKey }, { clockToleranceSeconds: 30 })

    // Assert
    expect(verified.sub).toBe('agent-builder-1')
  })

  test('honors an injected verification time', async () => {
    // Arrange
    const iat = 1_000_000
    const token = mintToken({
      payload: standardClaims({ iat, exp: iat + 300 }),
      privateKey: rsaKeys.privateKey
    })

    // Act
    const verified = await verifyToken(
      token,
      { publicKey: rsaKeys.publicKey },
      { now: new Date((iat + 100) * 1000) }
    )

    // Assert
    expect(verified.exp).toBe(iat + 300)
  })

  test('rejects a token signed by a different key', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: otherRsaKeys.privateKey })

    // Act + Assert
    await expectAuthError(verifyToken(token, { publicKey: rsaKeys.publicKey }), 'INVALID_SIGNATURE')
  })

  test('rejects a tampered payload', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey })
    const [header, , signature] = token.split('.')
    const tamperedPayload = Buffer.from(
      JSON.stringify(standardClaims({ scopes: ['runtime:promote:venture-42'] }))
    ).toString('base64url')
    const tampered = `${header}.${tamperedPayload}.${signature}`

    // Act + Assert
    await expectAuthError(verifyToken(tampered, { publicKey: rsaKeys.publicKey }), 'INVALID_SIGNATURE')
  })

  test.each([
    ['RS256', () => mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey, alg: 'RS256' })],
    ['none', () => mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey, alg: 'none' })]
  ])('rejects disallowed algorithm %s before touching the key', async (_alg, mint) => {
    // Arrange
    let keyRequested = false

    // Act + Assert
    await expectAuthError(
      verifyToken(mint(), {
        getPublicKey: () => {
          keyRequested = true
          return Promise.resolve(rsaKeys.publicKey)
        }
      }),
      'ALG_NOT_ALLOWED'
    )
    expect(keyRequested).toBe(false)
  })

  test.each([
    ['not-a-jwt'],
    ['a.b'],
    ['..'],
    ['%%%.###.@@@']
  ])('rejects malformed token %j', async (garbage) => {
    await expectAuthError(verifyToken(garbage, { publicKey: rsaKeys.publicKey }), 'MALFORMED_TOKEN')
  })

  test('rejects when the key resolver fails', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey })

    // Act + Assert
    await expectAuthError(
      verifyToken(token, { getPublicKey: () => Promise.reject(new Error('kms unreachable')) }),
      'KEY_RESOLUTION_FAILED'
    )
  })

  test('rejects an invalid PEM public key', async () => {
    // Arrange
    const token = mintToken({ payload: standardClaims(), privateKey: rsaKeys.privateKey })

    // Act + Assert
    await expectAuthError(verifyToken(token, { publicKey: 'not-a-pem' }), 'KEY_RESOLUTION_FAILED')
  })

  test('enforces issuer when configured', async () => {
    // Arrange
    const token = mintToken({
      payload: standardClaims({ iss: 'urn:someone-else' }),
      privateKey: rsaKeys.privateKey
    })

    // Act + Assert
    await expectAuthError(
      verifyToken(token, { publicKey: rsaKeys.publicKey }, { issuer: 'urn:platform:token-service' }),
      'INVALID_CLAIMS'
    )
  })

  test.each([
    ['missing sub', standardClaims({ sub: undefined })],
    ['empty sub', standardClaims({ sub: '' })],
    ['missing exp', standardClaims({ exp: undefined })],
    ['missing iat', standardClaims({ iat: undefined })],
    ['missing jti', standardClaims({ jti: undefined })],
    ['missing scopes', standardClaims({ scopes: undefined })],
    ['scopes not an array', standardClaims({ scopes: 'fs:write:a' })],
    ['non-string scope entry', standardClaims({ scopes: [42] })],
    ['grammar-invalid scope entry', standardClaims({ scopes: ['fs:Write:a'] })]
  ])('rejects claims: %s', async (_name, payload) => {
    // Arrange
    const cleaned = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
    const token = mintToken({ payload: cleaned, privateKey: rsaKeys.privateKey })

    // Act + Assert
    await expectAuthError(verifyToken(token, { publicKey: rsaKeys.publicKey }), 'INVALID_CLAIMS')
  })
})

describe('requireScope', () => {
  async function verifiedWith(scopes: readonly string[]): Promise<VerifiedToken> {
    const token = mintToken({
      payload: standardClaims({ scopes: [...scopes] }),
      privateKey: rsaKeys.privateKey
    })
    return verifyToken(token, { publicKey: rsaKeys.publicKey })
  }

  test('passes when a granted scope covers the requirement exactly', async () => {
    // Arrange
    const verified = await verifiedWith(['db:branch:venture-42'])

    // Act + Assert
    expect(() => requireScope(verified, 'db:branch:venture-42')).not.toThrow()
  })

  test('passes when a wildcard grant covers the requirement', async () => {
    // Arrange
    const verified = await verifiedWith(['fs:fork:venture-42/*'])

    // Act + Assert
    expect(() => requireScope(verified, 'fs:fork:venture-42/main')).not.toThrow()
  })

  test('throws SCOPE_DENIED when no grant covers the requirement (deny-by-default)', async () => {
    // Arrange
    const verified = await verifiedWith(['runtime:preview:venture-42'])

    // Act
    let caught: unknown
    try {
      requireScope(verified, 'runtime:promote:venture-42')
    } catch (error: unknown) {
      caught = error
    }

    // Assert
    expect(caught).toBeInstanceOf(AuthorizationError)
    const authError = caught as AuthorizationError
    expect(authError.code).toBe('SCOPE_DENIED')
    expect(authError.toJSON()).toEqual({
      error: {
        code: 'SCOPE_DENIED',
        message: expect.stringContaining('runtime:promote:venture-42'),
        remediation: expect.stringContaining('runtime:promote:venture-42')
      }
    })
  })

  test('throws on a grammar-invalid required scope (fail fast, never allow)', async () => {
    // Arrange
    const verified = await verifiedWith(['fs:write:venture-42/branch-x'])

    // Act + Assert
    expect(() => requireScope(verified, 'fs:write:venture-*')).toThrow('Invalid scope')
  })
})
