import { HostnameValidationError, TargetValidationError } from '../src/errors'
import { assertValidHostname, assertValidTarget, normalizeHostname } from '../src/validation'

describe('normalizeHostname', () => {
  test.each([
    ['Deploy-1.Venture.EXAMPLE.APP', 'deploy-1.venture.example.app'],
    ['  spaced.example.app  ', 'spaced.example.app'],
    ['already.lower.app', 'already.lower.app']
  ])('normalizes %p to %p', (input, expected) => {
    // Act
    const normalized = normalizeHostname(input)

    // Assert
    expect(normalized).toBe(expected)
  })
})

describe('assertValidHostname', () => {
  test.each([
    ['deploy-1.venture.example.app'],
    ['venture.example.app'],
    ['a.b'],
    ['1started-with-digit.example.app'],
    [`${'a'.repeat(63)}.example.app`]
  ])('accepts %p', (hostname) => {
    // Act + Assert
    expect(() => assertValidHostname(hostname)).not.toThrow()
  })

  test.each([
    ['', 'empty'],
    ['single-label', 'too few labels'],
    ['Upper.Example.App', 'uppercase letters'],
    ['-leading.example.app', 'leading hyphen'],
    ['trailing-.example.app', 'trailing hyphen'],
    ['under_score.example.app', 'underscore'],
    ['double..example.app', 'empty label'],
    ['host.example.app:443', 'port in hostname'],
    ['spa ce.example.app', 'whitespace'],
    [`${'a'.repeat(64)}.example.app`, 'label too long'],
    [`${'a.'.repeat(127)}${'a'.repeat(10)}`, 'hostname too long']
  ])('rejects %p (%s)', (hostname) => {
    // Act + Assert
    expect(() => assertValidHostname(hostname)).toThrow(HostnameValidationError)
  })

  test('carries a machine-readable code and a remediation hint', () => {
    // Act
    let thrown: unknown
    try {
      assertValidHostname('not a hostname')
    } catch (error: unknown) {
      thrown = error
    }

    // Assert
    expect(thrown).toBeInstanceOf(HostnameValidationError)
    const validationError = thrown as HostnameValidationError
    expect(validationError.code).toBe('INVALID_HOSTNAME')
    expect(validationError.hint).toContain('lowercase')
  })
})

describe('assertValidTarget', () => {
  test.each([
    ['https://cell-abc.ingress.internal:8443'],
    ['http://cell-abc.ingress.internal'],
    ['https://cell.example.com/path'],
    ['cell-abc.ingress.internal:8443'],
    ['cell-abc.ingress.internal'],
    ['single-label-host']
  ])('accepts %p', (target) => {
    // Act + Assert
    expect(() => assertValidTarget(target)).not.toThrow()
  })

  test.each([
    ['', 'empty'],
    ['ftp://cell.internal', 'non-http scheme'],
    ['https://', 'no hostname'],
    ['https://user:pass@cell.internal', 'embedded credentials'],
    ['cell.internal:0', 'port below range'],
    ['cell.internal:70000', 'port above range'],
    ['cell.internal:abc', 'non-numeric port'],
    ['cell.internal:1:2', 'multiple colons'],
    ['has space.internal', 'whitespace'],
    [`https://cell.internal/${'a'.repeat(1024)}`, 'over KVS value limit']
  ])('rejects %p (%s)', (target) => {
    // Act + Assert
    expect(() => assertValidTarget(target)).toThrow(TargetValidationError)
  })

  test('carries a machine-readable code and a remediation hint', () => {
    // Act
    let thrown: unknown
    try {
      assertValidTarget('')
    } catch (error: unknown) {
      thrown = error
    }

    // Assert
    expect(thrown).toBeInstanceOf(TargetValidationError)
    const validationError = thrown as TargetValidationError
    expect(validationError.code).toBe('INVALID_TARGET')
    expect(validationError.hint).toContain('host:port')
  })
})
