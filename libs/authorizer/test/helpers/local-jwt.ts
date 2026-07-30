/**
 * Test helpers: mint JWTs with local node:crypto keypairs so verification is
 * tested against independently produced signatures (not jose-signed tokens).
 */

import {
  constants as cryptoConstants,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject
} from 'node:crypto'

export interface TestRsaKeyPair {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
}

export function generateRsaKeyPair(): TestRsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKey, privateKey }
}

export function generateEcKeyPair(): TestRsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { publicKey, privateKey }
}

export function base64UrlEncodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export interface MintTokenInput {
  readonly payload: Record<string, unknown>
  readonly privateKey: KeyObject
  readonly alg?: 'PS256' | 'ES256' | 'RS256' | 'none'
  readonly kid?: string
}

/** Builds a compact JWT signed with a local key (or unsigned for alg "none"). */
export function mintToken({ payload, privateKey, alg = 'PS256', kid }: MintTokenInput): string {
  const header: Record<string, unknown> = { alg, typ: 'JWT', ...(kid !== undefined ? { kid } : {}) }
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`

  if (alg === 'none') {
    return `${signingInput}.`
  }

  const signature = signInput(signingInput, privateKey, alg)
  return `${signingInput}.${signature.toString('base64url')}`
}

function signInput(signingInput: string, privateKey: KeyObject, alg: 'PS256' | 'ES256' | 'RS256'): Buffer {
  const data = Buffer.from(signingInput)

  if (alg === 'PS256') {
    return cryptoSign('sha256', data, {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST
    })
  }

  if (alg === 'ES256') {
    return cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
  }

  return cryptoSign('sha256', data, { key: privateKey })
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Standard well-formed claims for a short-lived test token. */
export function standardClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = nowSeconds()

  return {
    sub: 'agent-builder-1',
    scopes: ['fs:write:venture-42/branch-x', 'db:branch:venture-42'],
    iat,
    exp: iat + 300,
    jti: 'test-jti-0001',
    ...overrides
  }
}
