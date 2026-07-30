/**
 * @platform/authorizer — capability-token verification and scope matching.
 *
 * Used by every platform service to enforce deny-by-default authorization:
 * - `verifyToken` — signature / expiry / claim verification (no AWS deps;
 *   takes a public key or resolver).
 * - `requireScope` — grammar-exact scope matching per
 *   `contracts/tokens/scope-grammar.md`.
 * - `parseScope` / `scopeCovers` / `isScopeSubset` — the scope grammar
 *   itself, shared with the token service for policy and attenuation checks.
 */

export {
  AuthorizationError,
  ScopeGrammarError,
  type AuthorizationErrorBody,
  type AuthorizationErrorCode
} from './errors'
export {
  isScopeSubset,
  isValidScope,
  MAX_SCOPE_LENGTH,
  parseScope,
  scopeCovers,
  WILDCARD_SEGMENT,
  type ParsedScope
} from './scopes'
export {
  ALLOWED_ALGORITHMS,
  requireScope,
  verifyToken,
  type KeySource,
  type PublicKeyInput,
  type ResolverKeySource,
  type StaticKeySource,
  type VerifiedToken,
  type VerifyTokenOptions
} from './verify'

/** Name of this library (stable identifier for logs/diagnostics). */
export const AUTHORIZER_LIBRARY_NAME: string = '@platform/authorizer'
