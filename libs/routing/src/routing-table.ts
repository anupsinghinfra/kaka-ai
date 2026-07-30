import {
  CloudFrontKeyValueStoreClient,
  ConflictException,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
  ResourceNotFoundException
} from '@aws-sdk/client-cloudfront-keyvaluestore'
import { pino, type Logger } from 'pino'
import { KeyValueStoreError, KvsArnValidationError, RouteConflictError, RoutingError } from './errors'
import { assertValidHostname, assertValidTarget, normalizeHostname } from './validation'

const KVS_ARN_PATTERN = /^arn:aws[a-z-]*:cloudfront::\d{12}:key-value-store\/[A-Za-z0-9-]+$/

const KVS_ARN_HINT =
  'Pass the KeyValueStore ARN published by the network stack at SSM parameter ' +
  '/platform/network/routing-table-kvs-arn.'

const KVS_ERROR_HINT =
  'Check IAM permissions for cloudfront-keyvaluestore:* on the routing-table ' +
  'KVS and that the store status is READY.'

/**
 * Writer/reader for the platform routing table (hostname -> cell-ingress
 * target) in the CloudFront KeyValueStore. Promote/rollback are `putRoute`
 * pointer flips on an existing hostname.
 */
export interface RoutingTable {
  /** Creates or overwrites the route for `hostname`. */
  putRoute(hostname: string, target: string): Promise<void>
  /** Removes the route for `hostname`; succeeds if it is already absent. */
  deleteRoute(hostname: string): Promise<void>
  /** Returns the target for `hostname`, or null when no route exists. */
  getRoute(hostname: string): Promise<string | null>
}

export interface CreateRoutingTableOptions {
  /** ARN of the routing-table KeyValueStore (data-plane operations target). */
  readonly kvsArn: string
  /**
   * Optional preconfigured client. The KVS data plane signs with SigV4a, so
   * the default client requires `@aws-sdk/signature-v4-crt` (a dependency of
   * this package).
   */
  readonly client?: CloudFrontKeyValueStoreClient
  /** Optional pino logger; a default JSON logger is created otherwise. */
  readonly logger?: Logger
}

interface ConflictRetryInput {
  readonly description: string
  readonly fetchEtag: () => Promise<string>
  readonly write: (ifMatch: string) => Promise<void>
  readonly logger: Logger
}

function toKvsError(error: unknown, description: string): RoutingError {
  if (error instanceof RoutingError) {
    return error
  }

  const detail = error instanceof Error ? error.message : 'Unexpected error'
  return new KeyValueStoreError(`KeyValueStore operation failed (${description}): ${detail}.`, KVS_ERROR_HINT, {
    cause: error
  })
}

/**
 * Runs an ETag-guarded KVS write: fetch the current ETag, write with IfMatch,
 * and on a conflict refresh the ETag and retry exactly once.
 */
async function writeWithConflictRetry(input: ConflictRetryInput): Promise<void> {
  const firstEtag = await input.fetchEtag()
  try {
    await input.write(firstEtag)
    return
  } catch (error: unknown) {
    if (!(error instanceof ConflictException)) {
      throw toKvsError(error, input.description)
    }
    input.logger.warn({ operation: input.description }, 'KVS ETag conflict; refreshing token and retrying once')
  }

  const secondEtag = await input.fetchEtag()
  try {
    await input.write(secondEtag)
  } catch (error: unknown) {
    if (error instanceof ConflictException) {
      throw new RouteConflictError(
        `Concurrent routing-table writers raced on "${input.description}" twice.`,
        'Serialize routing-table writes behind a single writer (the deployment registry) or retry with backoff.',
        { cause: error }
      )
    }
    throw toKvsError(error, input.description)
  }
}

/**
 * Creates a routing-table handle bound to one KeyValueStore.
 * Hostnames are normalized (trim + lowercase) and validated before every call.
 */
export function createRoutingTable(options: CreateRoutingTableOptions): RoutingTable {
  const { kvsArn } = options

  if (!KVS_ARN_PATTERN.test(kvsArn)) {
    throw new KvsArnValidationError(`"${kvsArn}" is not a CloudFront KeyValueStore ARN.`, KVS_ARN_HINT)
  }

  const client = options.client ?? new CloudFrontKeyValueStoreClient({})
  const logger = (options.logger ?? pino({ name: '@platform/routing' })).child({ kvsArn })

  const fetchEtag = async (): Promise<string> => {
    let etag: string | undefined
    try {
      const output = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }))
      etag = output.ETag
    } catch (error: unknown) {
      throw toKvsError(error, 'describe key-value store')
    }

    if (typeof etag !== 'string' || etag.length === 0) {
      throw new KeyValueStoreError(
        'DescribeKeyValueStore returned no ETag.',
        'The KeyValueStore may still be provisioning; wait until its status is READY and retry.'
      )
    }
    return etag
  }

  const putRoute = async (hostname: string, target: string): Promise<void> => {
    const key = normalizeHostname(hostname)
    assertValidHostname(key)
    assertValidTarget(target)

    await writeWithConflictRetry({
      description: `put route ${key}`,
      fetchEtag,
      logger,
      write: async (ifMatch: string): Promise<void> => {
        await client.send(new PutKeyCommand({ KvsARN: kvsArn, Key: key, Value: target, IfMatch: ifMatch }))
      }
    })
    logger.info({ hostname: key }, 'route written')
  }

  const deleteRoute = async (hostname: string): Promise<void> => {
    const key = normalizeHostname(hostname)
    assertValidHostname(key)

    await writeWithConflictRetry({
      description: `delete route ${key}`,
      fetchEtag,
      logger,
      write: async (ifMatch: string): Promise<void> => {
        try {
          await client.send(new DeleteKeyCommand({ KvsARN: kvsArn, Key: key, IfMatch: ifMatch }))
        } catch (error: unknown) {
          if (error instanceof ResourceNotFoundException) {
            logger.info({ hostname: key }, 'route already absent; delete is a no-op')
            return
          }
          throw error
        }
      }
    })
    logger.info({ hostname: key }, 'route deleted')
  }

  const getRoute = async (hostname: string): Promise<string | null> => {
    const key = normalizeHostname(hostname)
    assertValidHostname(key)

    try {
      const output = await client.send(new GetKeyCommand({ KvsARN: kvsArn, Key: key }))
      return output.Value ?? null
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return null
      }
      throw toKvsError(error, `get route ${key}`)
    }
  }

  return { putRoute, deleteRoute, getRoute }
}
