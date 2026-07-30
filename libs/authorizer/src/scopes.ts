/**
 * Capability scope grammar — parsing and matching.
 *
 * Implements `contracts/tokens/scope-grammar.md` (v0) exactly:
 *
 *   scope     = primitive ":" verb [ ":" resource ]
 *   primitive = 1*( lowercase / digit / "_" )
 *   verb      = 1*( lowercase / digit / "_" )
 *   resource  = segment *( "/" segment )
 *   segment   = 1*( lowercase / digit / "_" / "-" / "." / "*" )
 *
 * Normative semantics implemented here:
 * - A scope without a resource part grants the verb on the whole primitive.
 * - `*` is a single-segment wildcard; matching is exact per segment; there is
 *   no implicit prefix matching (segment counts must match exactly).
 *
 * Strictest-reading decisions (the grammar is ambiguous; we take the narrow
 * interpretation and note it):
 * - The segment charset admits `*` alongside other characters, but the
 *   semantics only define `*` as a *single-segment* wildcard. We therefore
 *   reject partial-wildcard segments such as `venture-*` — a segment is
 *   either the literal `*` or contains no `*` at all.
 * - The grammar defines no verb or primitive wildcard (their charsets exclude
 *   `*`), so `fs:*` is rejected; grants must enumerate verbs.
 */

import { ScopeGrammarError } from './errors'

/** Upper bound on scope string length (input-validation / DoS guard). */
export const MAX_SCOPE_LENGTH = 256

/** The single-segment wildcard token. */
export const WILDCARD_SEGMENT = '*'

const NAME_PATTERN = /^[a-z0-9_]+$/
const LITERAL_SEGMENT_PATTERN = /^[a-z0-9_.-]+$/

/** A scope string decomposed per the grammar. */
export interface ParsedScope {
  readonly primitive: string
  readonly verb: string
  /** Absent when the scope grants the verb on the whole primitive. */
  readonly resourceSegments?: readonly string[]
}

/**
 * Parses a scope string, throwing {@link ScopeGrammarError} when the string
 * does not conform to the grammar.
 */
export function parseScope(scope: string): ParsedScope {
  if (scope.length === 0) {
    throw new ScopeGrammarError(scope, 'scope must be a non-empty string')
  }

  if (scope.length > MAX_SCOPE_LENGTH) {
    throw new ScopeGrammarError(scope, `scope exceeds ${MAX_SCOPE_LENGTH} characters`)
  }

  const parts = scope.split(':')

  if (parts.length < 2 || parts.length > 3) {
    throw new ScopeGrammarError(scope, 'expected "primitive:verb" or "primitive:verb:resource"')
  }

  const [primitive, verb, resource] = parts

  if (!NAME_PATTERN.test(primitive)) {
    throw new ScopeGrammarError(scope, 'primitive must match [a-z0-9_]+')
  }

  if (!NAME_PATTERN.test(verb)) {
    throw new ScopeGrammarError(scope, 'verb must match [a-z0-9_]+')
  }

  if (resource === undefined) {
    return Object.freeze({ primitive, verb })
  }

  const resourceSegments = Object.freeze(resource.split('/').map((segment) => parseSegment(scope, segment)))

  return Object.freeze({ primitive, verb, resourceSegments })
}

function parseSegment(scope: string, segment: string): string {
  if (segment === WILDCARD_SEGMENT) {
    return segment
  }

  if (segment.includes(WILDCARD_SEGMENT)) {
    throw new ScopeGrammarError(
      scope,
      '"*" is only valid as an entire segment (single-segment wildcard); partial wildcards are not defined by the grammar'
    )
  }

  if (!LITERAL_SEGMENT_PATTERN.test(segment)) {
    throw new ScopeGrammarError(scope, `resource segment "${segment}" must match [a-z0-9_.-]+`)
  }

  return segment
}

/** Returns true when the string is a well-formed scope. */
export function isValidScope(scope: string): boolean {
  try {
    parseScope(scope)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true when the `granted` scope authorizes everything the `required`
 * scope asks for (i.e. `granted` covers `required`).
 *
 * Rules (normative, from the grammar doc):
 * - primitive and verb must match exactly (no wildcards exist for either);
 * - a granted scope with no resource part covers any resource under that
 *   primitive+verb;
 * - a granted scope *with* a resource part never covers a required scope
 *   without one (the requirement is broader than the grant);
 * - resources match segment-by-segment with equal segment counts — `*` in the
 *   granted scope matches any single required segment. A literal granted
 *   segment does not cover a required `*` (the requirement is broader).
 */
export function scopeCovers(granted: string | ParsedScope, required: string | ParsedScope): boolean {
  const grantedScope = typeof granted === 'string' ? parseScope(granted) : granted
  const requiredScope = typeof required === 'string' ? parseScope(required) : required

  if (grantedScope.primitive !== requiredScope.primitive || grantedScope.verb !== requiredScope.verb) {
    return false
  }

  if (grantedScope.resourceSegments === undefined) {
    return true
  }

  if (requiredScope.resourceSegments === undefined) {
    return false
  }

  if (grantedScope.resourceSegments.length !== requiredScope.resourceSegments.length) {
    return false
  }

  return grantedScope.resourceSegments.every((grantedSegment, index) => {
    const requiredSegment = (requiredScope.resourceSegments as readonly string[])[index]
    return grantedSegment === WILDCARD_SEGMENT || grantedSegment === requiredSegment
  })
}

/**
 * Returns true when every scope in `requested` is covered by at least one
 * scope in `granted` (deny-by-default subset check — used for both policy
 * enforcement and parent-token attenuation).
 *
 * Throws {@link ScopeGrammarError} if any input scope is malformed: subset
 * decisions must never be made over strings we could not parse.
 */
export function isScopeSubset(requested: readonly string[], granted: readonly string[]): boolean {
  const grantedParsed = granted.map((scope) => parseScope(scope))

  return requested.every((requestedScope) => {
    const requiredParsed = parseScope(requestedScope)
    return grantedParsed.some((grantedScope) => scopeCovers(grantedScope, requiredParsed))
  })
}
