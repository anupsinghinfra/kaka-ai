import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms'
import { KMS_RAW_MESSAGE_LIMIT_BYTES, KmsJwtSigner, type KmsSigningClient } from '../src/kms-signer'
import { decodeJwtPart, FakeKmsClient, generateTestKeyPair, sha256 } from './helpers/fakes'

const keys = generateTestKeyPair()
const KEY_ID = 'arn:aws:kms:us-east-1:111111111111:key/test-key-id'

describe('KmsJwtSigner.sign', () => {
  test('uses RAW message mode for normal-sized signing input', async () => {
    // Arrange
    const kms = new FakeKmsClient(keys)
    const signer = new KmsJwtSigner(kms, KEY_ID)

    // Act
    const token = await signer.sign({ sub: 'p-1', scopes: ['db:branch:venture-42'], iat: 1, exp: 2, jti: 'j' })

    // Assert
    const [headerPart, payloadPart, signaturePart] = token.split('.')
    expect(decodeJwtPart(headerPart)).toEqual({ alg: 'PS256', typ: 'JWT', kid: KEY_ID })
    expect(decodeJwtPart(payloadPart)['sub']).toBe('p-1')
    expect(signaturePart.length).toBeGreaterThan(0)
    expect(kms.signCommands[0].input.MessageType).toBe('RAW')
  })

  test('switches to DIGEST mode above the KMS RAW size limit and sends the sha256 of the signing input', async () => {
    // Arrange
    const kms = new FakeKmsClient(keys)
    const signer = new KmsJwtSigner(kms, KEY_ID)
    const hugeClaim = 'a'.repeat(KMS_RAW_MESSAGE_LIMIT_BYTES)

    // Act
    const token = await signer.sign({ sub: 'p-1', note: hugeClaim })

    // Assert
    const input = kms.signCommands[0].input
    expect(input.MessageType).toBe('DIGEST')
    const [headerPart, payloadPart] = token.split('.')
    const expectedDigest = sha256(Buffer.from(`${headerPart}.${payloadPart}`))
    expect(Buffer.from(input.Message as Uint8Array)).toEqual(expectedDigest)
  })

  test('throws when KMS returns no signature', async () => {
    // Arrange
    const emptyKms: KmsSigningClient = {
      send: (command: SignCommand | GetPublicKeyCommand) => {
        void command
        return Promise.resolve({ $metadata: {} })
      }
    }
    const signer = new KmsJwtSigner(emptyKms, KEY_ID)

    // Act + Assert
    await expect(signer.sign({ sub: 'p-1' })).rejects.toThrow('no signature')
  })
})

describe('KmsJwtSigner.getPublicKey', () => {
  test('returns the SPKI public key and caches it after the first fetch', async () => {
    // Arrange
    let calls = 0
    const countingKms: KmsSigningClient = {
      send: (command: SignCommand | GetPublicKeyCommand) => {
        void command
        calls += 1
        const der = keys.publicKey.export({ type: 'spki', format: 'der' })
        return Promise.resolve({ PublicKey: new Uint8Array(der), $metadata: {} })
      }
    }
    const signer = new KmsJwtSigner(countingKms, KEY_ID)

    // Act
    const first = await signer.getPublicKey()
    const second = await signer.getPublicKey()

    // Assert
    expect(first.equals(keys.publicKey)).toBe(true)
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  test('throws when KMS returns no public key', async () => {
    // Arrange
    const emptyKms: KmsSigningClient = {
      send: () => Promise.resolve({ $metadata: {} })
    }
    const signer = new KmsJwtSigner(emptyKms, KEY_ID)

    // Act + Assert
    await expect(signer.getPublicKey()).rejects.toThrow('no public key')
  })
})
