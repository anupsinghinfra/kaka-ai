/**
 * JWT signing via AWS KMS (asymmetric RSA_2048 SIGN_VERIFY key, PS256).
 *
 * The private key never leaves KMS. The compact JWT is assembled locally and
 * only the signature comes from the KMS Sign API. We use RSA/PS256 (not
 * EC/ES256) so the KMS signature is byte-for-byte the JWS signature — ECDSA
 * would require DER -> IEEE P1363 conversion, a classic source of subtle bugs.
 */

import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import {
  GetPublicKeyCommand,
  SignCommand,
  type GetPublicKeyCommandOutput,
  type SignCommandOutput
} from '@aws-sdk/client-kms'

/** KMS signing algorithm backing the JWT `alg` below. */
export const KMS_SIGNING_ALGORITHM = 'RSASSA_PSS_SHA_256'

/** JOSE algorithm stamped into every token header. */
export const JWT_ALGORITHM = 'PS256'

/**
 * KMS Sign accepts at most 4096 bytes of RAW message; larger payloads must be
 * pre-hashed and sent as a DIGEST. Both produce identical signatures.
 */
export const KMS_RAW_MESSAGE_LIMIT_BYTES = 4096

type KmsCommand = SignCommand | GetPublicKeyCommand
type KmsOutput = SignCommandOutput | GetPublicKeyCommandOutput

/** Minimal structural view of KMSClient (injectable for tests). */
export interface KmsSigningClient {
  send(command: KmsCommand): Promise<KmsOutput>
}

export interface JwtSigner {
  /** Signs the claims into a compact JWT. Header: { alg, typ, kid }. */
  sign(claims: Readonly<Record<string, unknown>>): Promise<string>
  /** Returns the verification (public) key for the signing key, cached after first fetch. */
  getPublicKey(): Promise<KeyObject>
}

export class KmsJwtSigner implements JwtSigner {
  private readonly client: KmsSigningClient
  private readonly keyId: string
  private cachedPublicKey: KeyObject | undefined

  constructor(client: KmsSigningClient, keyId: string) {
    this.client = client
    this.keyId = keyId
  }

  async sign(claims: Readonly<Record<string, unknown>>): Promise<string> {
    const header = { alg: JWT_ALGORITHM, typ: 'JWT', kid: this.keyId }
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`
    const signingInputBytes = Buffer.from(signingInput, 'utf8')

    const usesRawMessage = signingInputBytes.byteLength <= KMS_RAW_MESSAGE_LIMIT_BYTES
    const output = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        SigningAlgorithm: KMS_SIGNING_ALGORITHM,
        MessageType: usesRawMessage ? 'RAW' : 'DIGEST',
        Message: usesRawMessage ? signingInputBytes : createHash('sha256').update(signingInputBytes).digest()
      })
    )

    if (!('Signature' in output) || output.Signature === undefined) {
      throw new Error('KMS Sign returned no signature')
    }

    return `${signingInput}.${Buffer.from(output.Signature).toString('base64url')}`
  }

  async getPublicKey(): Promise<KeyObject> {
    if (this.cachedPublicKey !== undefined) {
      return this.cachedPublicKey
    }

    const output = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }))

    if (!('PublicKey' in output) || output.PublicKey === undefined) {
      throw new Error('KMS GetPublicKey returned no public key')
    }

    const publicKey = createPublicKey({
      key: Buffer.from(output.PublicKey),
      format: 'der',
      type: 'spki'
    })
    this.cachedPublicKey = publicKey

    return publicKey
  }
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}
