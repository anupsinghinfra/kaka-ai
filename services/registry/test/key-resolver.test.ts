import { createKmsKeyResolver, type KmsPublicKeyClient } from '../src/key-resolver'
import { FailingKmsClient, FakeKmsClient, generateTestKeyPair } from './helpers/fakes'

const KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/test-key-id'

describe('createKmsKeyResolver', () => {
  test('fetches the public key from KMS once and caches it', async () => {
    // Arrange
    const keys = generateTestKeyPair()
    const client = new FakeKmsClient(keys.publicKey)
    const resolve = createKmsKeyResolver(client, KEY_ARN)

    // Act
    const [first, second] = await Promise.all([resolve(), resolve()])
    const third = await resolve()

    // Assert: single KMS call, stable KeyObject, correct key material
    expect(client.getPublicKeyCommands).toHaveLength(1)
    expect(client.getPublicKeyCommands[0].input.KeyId).toBe(KEY_ARN)
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(first.export({ type: 'spki', format: 'pem' })).toEqual(
      keys.publicKey.export({ type: 'spki', format: 'pem' })
    )
  })

  test('propagates KMS failures and retries on the next call', async () => {
    // Arrange
    const failing = new FailingKmsClient()
    const resolve = createKmsKeyResolver(failing, KEY_ARN)

    // Act + Assert: failure is not cached
    await expect(resolve()).rejects.toThrow('KMS unavailable')
    await expect(resolve()).rejects.toThrow('KMS unavailable')
  })

  test('rejects a KMS response without key material', async () => {
    // Arrange
    const emptyClient: KmsPublicKeyClient = {
      send: () => Promise.resolve({ $metadata: {} })
    }
    const resolve = createKmsKeyResolver(emptyClient, KEY_ARN)

    // Act + Assert
    await expect(resolve()).rejects.toThrow('no public key')
  })
})
