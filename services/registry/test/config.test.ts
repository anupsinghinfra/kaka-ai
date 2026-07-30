import { loadConfig } from '../src/config'

const VALID_ENV: NodeJS.ProcessEnv = {
  VENTURES_TABLE_NAME: 'ventures',
  OWNER_INDEX_NAME: 'ownerId-index',
  EVENT_BUS_NAME: 'platform-bus',
  SIGNING_KEY_ARN: 'arn:aws:kms:us-east-1:111111111111:key/test-key-id'
}

describe('loadConfig', () => {
  test('loads a complete environment with the default log level', () => {
    // Arrange + Act
    const config = loadConfig({ ...VALID_ENV })

    // Assert
    expect(config).toEqual({
      venturesTableName: 'ventures',
      ownerIndexName: 'ownerId-index',
      eventBusName: 'platform-bus',
      signingKeyArn: 'arn:aws:kms:us-east-1:111111111111:key/test-key-id',
      logLevel: 'info'
    })
  })

  test('honors LOG_LEVEL when set', () => {
    const config = loadConfig({ ...VALID_ENV, LOG_LEVEL: 'debug' })

    expect(config.logLevel).toBe('debug')
  })

  test.each(['VENTURES_TABLE_NAME', 'OWNER_INDEX_NAME', 'EVENT_BUS_NAME', 'SIGNING_KEY_ARN'])(
    'fails fast when %s is missing',
    (name) => {
      // Arrange
      const env = { ...VALID_ENV }
      delete env[name]

      // Act + Assert
      expect(() => loadConfig(env)).toThrow(name)
    }
  )

  test('treats an empty required value as missing', () => {
    expect(() => loadConfig({ ...VALID_ENV, EVENT_BUS_NAME: '' })).toThrow('EVENT_BUS_NAME')
  })
})
