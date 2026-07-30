/**
 * Lambda entrypoint — pure wiring: env config, real AWS clients, handler.
 * All logic lives in ./handler and friends (unit-tested with injected deps).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { KMSClient } from '@aws-sdk/client-kms'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createPublisher } from '@platform/events'
import { loadConfig } from './config'
import { createRegistryHandler, type RegistryHandler } from './handler'
import { createKmsKeyResolver } from './key-resolver'
import { createLogger } from './logging'
import { DynamoDbVentureRepository } from './venture-store'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
})
const kmsClient = new KMSClient({})

export const handler: RegistryHandler = createRegistryHandler({
  ventures: new DynamoDbVentureRepository(documentClient, config.venturesTableName, config.ownerIndexName),
  publisher: createPublisher({ busName: config.eventBusName, source: 'registry' }),
  getVerificationKey: createKmsKeyResolver(kmsClient, config.signingKeyArn),
  logger
})
