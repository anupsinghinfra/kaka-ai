import { DEFAULT_TTL_SECONDS, loadConfig, MAX_TTL_SECONDS } from '../src/config'

const REQUIRED_ENV = {
  POLICIES_TABLE_NAME: 'policies',
  SIGNING_KEY_ID: 'arn:aws:kms:us-east-1:111111111111:key/abc'
}

describe('loadConfig', () => {
  test('loads required values and applies TTL defaults', () => {
    // Act
    const config = loadConfig({ ...REQUIRED_ENV })

    // Assert
    expect(config).toEqual({
      policiesTableName: 'policies',
      signingKeyId: REQUIRED_ENV.SIGNING_KEY_ID,
      defaultTtlSeconds: DEFAULT_TTL_SECONDS,
      maxTtlSeconds: MAX_TTL_SECONDS,
      logLevel: 'info'
    })
  })

  test('honors TTL and log-level overrides', () => {
    // Act
    const config = loadConfig({
      ...REQUIRED_ENV,
      DEFAULT_TOKEN_TTL_SECONDS: '60',
      MAX_TOKEN_TTL_SECONDS: '600',
      LOG_LEVEL: 'debug'
    })

    // Assert
    expect(config.defaultTtlSeconds).toBe(60)
    expect(config.maxTtlSeconds).toBe(600)
    expect(config.logLevel).toBe('debug')
  })

  test.each(['POLICIES_TABLE_NAME', 'SIGNING_KEY_ID'])('fails fast when %s is missing', (name) => {
    // Arrange
    const env: NodeJS.ProcessEnv = { ...REQUIRED_ENV }
    delete env[name]

    // Act + Assert
    expect(() => loadConfig(env)).toThrow(name)
  })

  test.each([
    ['not-a-number'],
    ['0'],
    ['-5'],
    ['1.5'],
    ['901']
  ])('rejects invalid MAX_TOKEN_TTL_SECONDS %j', (value) => {
    expect(() => loadConfig({ ...REQUIRED_ENV, MAX_TOKEN_TTL_SECONDS: value })).toThrow('MAX_TOKEN_TTL_SECONDS')
  })

  test('rejects a default TTL above the max TTL', () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENV, DEFAULT_TOKEN_TTL_SECONDS: '600', MAX_TOKEN_TTL_SECONDS: '300' })
    ).toThrow('must not exceed')
  })
})
