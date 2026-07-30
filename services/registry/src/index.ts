/**
 * @platform/registry — venture registry service (EXECUTION.md M0 item 5).
 * Public surface for tests and platform tooling; the deployable artifact is
 * `src/lambda.ts` (bundled by the RegistryStack).
 */

export { authenticate } from './auth'
export {
  DEFAULT_PAGE_SIZE,
  loadConfig,
  MAX_PAGE_SIZE,
  TOKEN_ISSUER,
  VENTURE_ID_PATTERN,
  type ServiceConfig
} from './config'
export {
  internalError,
  RegistryError,
  ventureNotFound,
  type RegistryErrorBody,
  type RegistryErrorCode,
  type RegistryErrorDetail
} from './errors'
export {
  publishMutationEvent,
  VENTURE_CREATED_EVENT,
  VENTURE_DELETED_EVENT,
  VENTURE_MANIFEST_UPDATED_EVENT
} from './event-publish'
export { createRegistryHandler, type RegistryHandler } from './handler'
export { createKmsKeyResolver, type KmsPublicKeyClient } from './key-resolver'
export { createLogger, type Logger } from './logging'
export { assertValidManifest } from './manifest-validation'
export { DynamoDbVentureRepository, type VentureStoreClient } from './venture-store'
export type {
  HandlerDependencies,
  OwnerIndexKey,
  ResponseWarning,
  VentureListResponseBody,
  VenturePage,
  VentureRecord,
  VentureRepository,
  VentureResponseBody,
  VentureStatus
} from './types'
