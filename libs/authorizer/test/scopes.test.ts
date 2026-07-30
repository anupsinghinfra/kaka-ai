import {
  isScopeSubset,
  isValidScope,
  MAX_SCOPE_LENGTH,
  parseScope,
  ScopeGrammarError,
  scopeCovers
} from '../src/index'

describe('parseScope', () => {
  test('parses primitive:verb without a resource part', () => {
    // Act
    const parsed = parseScope('registry:create')

    // Assert
    expect(parsed).toEqual({ primitive: 'registry', verb: 'create' })
    expect(parsed.resourceSegments).toBeUndefined()
  })

  test('parses a multi-segment resource into segments', () => {
    // Act
    const parsed = parseScope('fs:write:venture-42/branch-x')

    // Assert
    expect(parsed).toEqual({
      primitive: 'fs',
      verb: 'write',
      resourceSegments: ['venture-42', 'branch-x']
    })
  })

  test('accepts a full-segment wildcard', () => {
    // Act
    const parsed = parseScope('fs:fork:venture-42/*')

    // Assert
    expect(parsed.resourceSegments).toEqual(['venture-42', '*'])
  })

  test('returns frozen objects (immutability)', () => {
    // Act
    const parsed = parseScope('db:branch:venture-42')

    // Assert
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.resourceSegments)).toBe(true)
  })

  test.each([
    ['', 'empty string'],
    ['fs', 'missing verb'],
    ['fs:write:a/b:extra', 'too many colons'],
    ['Fs:write:a', 'uppercase primitive'],
    ['fs:Write:a', 'uppercase verb'],
    ['fs:*:a', 'verb wildcard is not defined by the grammar'],
    ['*:write:a', 'primitive wildcard is not defined by the grammar'],
    ['fs:write:', 'empty resource'],
    ['fs:write:a//b', 'empty segment'],
    ['fs:write:/a', 'leading slash'],
    ['fs:write:a/', 'trailing slash'],
    ['fs:write:venture-*', 'partial wildcard segment (strictest reading)'],
    ['fs:write:A', 'uppercase segment'],
    ['fs:write:a b', 'whitespace in segment'],
    ['fs-x:write:a', 'hyphen not allowed in primitive'],
    [':write:a', 'empty primitive'],
    ['fs::a', 'empty verb']
  ])('rejects %j (%s)', (scope) => {
    // Act + Assert
    expect(() => parseScope(scope)).toThrow(ScopeGrammarError)
    expect(isValidScope(scope)).toBe(false)
  })

  test('rejects scopes exceeding the maximum length', () => {
    // Arrange
    const oversized = `fs:write:${'a'.repeat(MAX_SCOPE_LENGTH)}`

    // Act + Assert
    expect(() => parseScope(oversized)).toThrow(ScopeGrammarError)
  })

  test('isValidScope returns true for a well-formed scope', () => {
    expect(isValidScope('email:send:venture-42')).toBe(true)
  })
})

describe('scopeCovers', () => {
  test.each<[string, string, boolean, string]>([
    ['fs:write:venture-42/branch-x', 'fs:write:venture-42/branch-x', true, 'exact match'],
    ['fs:write:venture-42/branch-x', 'fs:write:venture-42/branch-y', false, 'different segment'],
    ['fs:fork:venture-42/*', 'fs:fork:venture-42/main', true, 'wildcard matches one segment'],
    ['fs:fork:venture-42/*', 'fs:fork:venture-43/main', false, 'literal segment must match'],
    ['fs:fork:venture-42/*', 'fs:fork:venture-42/a/b', false, 'no prefix matching: segment counts differ'],
    ['fs:fork:venture-42/*', 'fs:fork:venture-42', false, 'wildcard does not cover shorter resource'],
    ['fs:fork:*/*', 'fs:fork:venture-42/main', true, 'multiple wildcards'],
    ['db:branch', 'db:branch:venture-42', true, 'no-resource grant covers whole primitive verb'],
    ['db:branch', 'db:branch', true, 'no-resource grant covers no-resource requirement'],
    ['db:branch:venture-42', 'db:branch', false, 'restricted grant cannot cover whole-primitive requirement'],
    ['db:branch:venture-42', 'db:promote:venture-42', false, 'verbs must match exactly'],
    ['db:branch:venture-42', 'fs:branch:venture-42', false, 'primitives must match exactly'],
    ['fs:write:venture-42', 'fs:write:venture-42/*', false, 'segment counts differ even with wildcard requirement'],
    ['fs:write:venture-42/main', 'fs:write:venture-42/*', false, 'literal grant does not cover wildcard requirement'],
    ['runtime:preview:venture-42', 'runtime:promote:venture-42', false, 'preview never implies promote']
  ])('%s covers %s -> %s (%s)', (granted, required, expected) => {
    // Act + Assert
    expect(scopeCovers(granted, required)).toBe(expected)
  })

  test('accepts pre-parsed scopes', () => {
    // Arrange
    const granted = parseScope('fs:fork:venture-42/*')
    const required = parseScope('fs:fork:venture-42/main')

    // Act + Assert
    expect(scopeCovers(granted, required)).toBe(true)
  })
})

describe('isScopeSubset', () => {
  test('returns true when every requested scope is covered by a grant', () => {
    // Arrange
    const granted = ['fs:fork:venture-42/*', 'db:branch:venture-42', 'runtime:preview:venture-42']
    const requested = ['fs:fork:venture-42/main', 'db:branch:venture-42']

    // Act + Assert
    expect(isScopeSubset(requested, granted)).toBe(true)
  })

  test('returns false when any requested scope escapes the grants (deny-by-default)', () => {
    // Arrange
    const granted = ['runtime:preview:venture-42']
    const requested = ['runtime:preview:venture-42', 'runtime:promote:venture-42']

    // Act + Assert
    expect(isScopeSubset(requested, granted)).toBe(false)
  })

  test('empty grants deny every request', () => {
    expect(isScopeSubset(['fs:read:venture-42'], [])).toBe(false)
  })

  test('empty request is trivially a subset', () => {
    expect(isScopeSubset([], ['fs:read:venture-42'])).toBe(true)
  })

  test('a requested wildcard is only covered by an equal-or-wider grant', () => {
    // Assert: wildcard request under literal grant is an escalation
    expect(isScopeSubset(['fs:fork:venture-42/*'], ['fs:fork:venture-42/main'])).toBe(false)
    // Assert: wildcard request under identical wildcard grant is fine
    expect(isScopeSubset(['fs:fork:venture-42/*'], ['fs:fork:venture-42/*'])).toBe(true)
    // Assert: wildcard request under whole-primitive grant is fine
    expect(isScopeSubset(['fs:fork:venture-42/*'], ['fs:fork'])).toBe(true)
  })

  test('throws on malformed scopes instead of deciding over garbage', () => {
    expect(() => isScopeSubset(['fs:write:venture-*'], ['fs:write'])).toThrow(ScopeGrammarError)
    expect(() => isScopeSubset(['fs:write:a'], ['not a scope'])).toThrow(ScopeGrammarError)
  })
})
