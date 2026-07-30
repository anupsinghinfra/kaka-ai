/**
 * @platform/routing — writer library for the platform edge routing table.
 *
 * The CloudFront viewer-request function resolves every Host header against
 * the `routing-table` KeyValueStore (see infra/lib/primitives/network). This
 * package is the only sanctioned writer: the deployment registry uses it to
 * map `{deploy-id}.{venture}.{platformDomain}` hostnames to cell-ingress
 * targets, and promote/rollback are `putRoute` pointer flips.
 */

export {
  HostnameValidationError,
  KeyValueStoreError,
  KvsArnValidationError,
  RouteConflictError,
  RoutingError,
  type RoutingErrorCode,
  type RoutingErrorOptions,
  TargetValidationError
} from './errors'
export {
  createRoutingTable,
  type CreateRoutingTableOptions,
  type RoutingTable
} from './routing-table'
export { assertValidHostname, assertValidTarget, normalizeHostname } from './validation'
