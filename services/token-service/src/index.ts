/**
 * @platform/token-service — capability token issuance.
 * Public surface for tests and (rare) in-process consumers; the deployable
 * artifact is the bundled `src/lambda.ts` handler.
 */

export { DEFAULT_TTL_SECONDS, loadConfig, MAX_TTL_SECONDS, TOKEN_ISSUER, type ServiceConfig } from './config'
export { internalError, TokenServiceError, type TokenServiceErrorBody, type TokenServiceErrorCode } from './errors'
export {
  createIssueTokenHandler,
  type HandlerDependencies,
  type IssueTokenHandler,
  type IssueTokenResponseBody
} from './handler'
export {
  JWT_ALGORITHM,
  KMS_RAW_MESSAGE_LIMIT_BYTES,
  KMS_SIGNING_ALGORITHM,
  KmsJwtSigner,
  type JwtSigner,
  type KmsSigningClient
} from './kms-signer'
export { createLogger, type Logger } from './logging'
export {
  DynamoDbPolicyRepository,
  type PolicyDocument,
  type PolicyRepository,
  type PolicyStoreClient
} from './policy-store'
export { MAX_SCOPES_PER_TOKEN, parseIssueTokenRequest, type IssueTokenRequest } from './request'
