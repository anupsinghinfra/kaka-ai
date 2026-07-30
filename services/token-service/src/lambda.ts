/**
 * Lambda entrypoint — pure wiring: env config, real AWS clients, handler.
 * All logic lives in ./handler and friends (unit-tested with injected deps).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { KMSClient } from '@aws-sdk/client-kms'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { loadConfig } from './config'
import { createIssueTokenHandler, type IssueTokenHandler } from './handler'
import { KmsJwtSigner } from './kms-signer'
import { createLogger } from './logging'
import { DynamoDbPolicyRepository } from './policy-store'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)

const kmsClient = new KMSClient({})
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const signer = new KmsJwtSigner(kmsClient, config.signingKeyId)
const policies = new DynamoDbPolicyRepository(documentClient, config.policiesTableName)

export const handler: IssueTokenHandler = createIssueTokenHandler({
  policies,
  signer,
  getVerificationKey: () => signer.getPublicKey(),
  config,
  logger
})
