/**
 * Verification-key resolution: fetches the token-signing public key from KMS
 * (`GetPublicKey`) once per container and caches the KeyObject in memory.
 * Concurrent cold-start callers share a single in-flight fetch; a failed
 * fetch is not cached, so the next request retries.
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import { GetPublicKeyCommand, type GetPublicKeyCommandOutput } from '@aws-sdk/client-kms'

/** Minimal structural view of KMSClient (injectable for tests). */
export interface KmsPublicKeyClient {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>
}

export function createKmsKeyResolver(client: KmsPublicKeyClient, signingKeyArn: string): () => Promise<KeyObject> {
  let cached: KeyObject | undefined
  let inFlight: Promise<KeyObject> | undefined

  async function fetchKey(): Promise<KeyObject> {
    const output = await client.send(new GetPublicKeyCommand({ KeyId: signingKeyArn }))

    if (output.PublicKey === undefined) {
      throw new Error(`KMS GetPublicKey returned no public key for "${signingKeyArn}"`)
    }

    return createPublicKey({
      key: Buffer.from(output.PublicKey),
      format: 'der',
      type: 'spki'
    })
  }

  return async (): Promise<KeyObject> => {
    if (cached !== undefined) {
      return cached
    }

    if (inFlight === undefined) {
      inFlight = fetchKey()
        .then((key) => {
          cached = key
          return key
        })
        .finally(() => {
          inFlight = undefined
        })
    }

    return inFlight
  }
}
