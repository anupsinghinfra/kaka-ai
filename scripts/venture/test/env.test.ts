import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMissingEnvVars, loadEnvFile, parseEnvFile } from '../lib/env'

describe('parseEnvFile', () => {
  test('parses KEY=VALUE lines and skips comments and blanks', () => {
    // Arrange
    const content = ['# comment', '', 'ONCELL_API_KEY=abc123', 'ONCELL_API_URL=https://api.oncell.ai'].join('\n')

    // Act
    const vars = parseEnvFile(content)

    // Assert
    expect(vars).toEqual({
      ONCELL_API_KEY: 'abc123',
      ONCELL_API_URL: 'https://api.oncell.ai'
    })
  })

  test('strips matched surrounding quotes and preserves inner equals signs', () => {
    // Arrange
    const content = ['A="quoted value"', "B='single'", 'C=a=b=c'].join('\n')

    // Act
    const vars = parseEnvFile(content)

    // Assert
    expect(vars).toEqual({ A: 'quoted value', B: 'single', C: 'a=b=c' })
  })

  test('ignores malformed lines without a key', () => {
    // Arrange
    const content = ['=nokey', 'JUSTTEXT', 'OK=yes'].join('\n')

    // Act
    const vars = parseEnvFile(content)

    // Assert
    expect(vars).toEqual({ OK: 'yes' })
  })
})

describe('applyMissingEnvVars', () => {
  test('fills missing keys but never overrides existing environment values', () => {
    // Arrange
    const env: NodeJS.ProcessEnv = { EXISTING: 'kept' }

    // Act
    applyMissingEnvVars({ EXISTING: 'ignored', ADDED: 'new' }, env)

    // Assert
    expect(env['EXISTING']).toBe('kept')
    expect(env['ADDED']).toBe('new')
  })
})

describe('loadEnvFile', () => {
  test('loads variables from a file into the provided env', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'gp-env-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'FROM_FILE=hello\n')
    const env: NodeJS.ProcessEnv = {}

    // Act
    const loaded = loadEnvFile(path, env)

    // Assert
    expect(loaded).toBe(true)
    expect(env['FROM_FILE']).toBe('hello')
  })

  test('returns false when the file does not exist', () => {
    // Arrange
    const env: NodeJS.ProcessEnv = {}

    // Act
    const loaded = loadEnvFile(join(tmpdir(), 'gp-env-missing', '.env'), env)

    // Assert
    expect(loaded).toBe(false)
    expect(env).toEqual({})
  })
})
