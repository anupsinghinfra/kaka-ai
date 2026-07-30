/** Machine-readable error codes for routing-table operations. */
export type RoutingErrorCode =
  | 'INVALID_KVS_ARN'
  | 'INVALID_HOSTNAME'
  | 'INVALID_TARGET'
  | 'ROUTE_CONFLICT'
  | 'KVS_ERROR'

export interface RoutingErrorOptions {
  readonly cause?: unknown
}

/**
 * Base class for every error thrown by `@platform/routing`.
 * Carries a machine-readable `code` and a human remediation `hint`.
 */
export class RoutingError extends Error {
  readonly code: RoutingErrorCode
  readonly hint: string

  constructor(
    code: RoutingErrorCode,
    message: string,
    hint: string,
    options?: RoutingErrorOptions
  ) {
    super(message, { cause: options?.cause })
    this.name = new.target.name
    this.code = code
    this.hint = hint
  }
}

/** The KeyValueStore ARN passed to `createRoutingTable` is malformed. */
export class KvsArnValidationError extends RoutingError {
  constructor(message: string, hint: string) {
    super('INVALID_KVS_ARN', message, hint)
  }
}

/** A hostname failed lowercase DNS-label validation. */
export class HostnameValidationError extends RoutingError {
  constructor(message: string, hint: string) {
    super('INVALID_HOSTNAME', message, hint)
  }
}

/** A route target failed validation. */
export class TargetValidationError extends RoutingError {
  constructor(message: string, hint: string) {
    super('INVALID_TARGET', message, hint)
  }
}

/** A write lost the ETag race twice in a row (concurrent writers). */
export class RouteConflictError extends RoutingError {
  constructor(message: string, hint: string, options?: RoutingErrorOptions) {
    super('ROUTE_CONFLICT', message, hint, options)
  }
}

/** The KeyValueStore API failed for a non-conflict reason. */
export class KeyValueStoreError extends RoutingError {
  constructor(message: string, hint: string, options?: RoutingErrorOptions) {
    super('KVS_ERROR', message, hint, options)
  }
}
