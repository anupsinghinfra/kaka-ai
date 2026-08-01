import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_AWS_REGION,
  getAuthConfig,
  isAuthConfigured,
  resolveAuthConfig,
  startBuildingHref
} from '@/lib/auth/config'

/**
 * Auth config module — local mode vs configured, resolved purely from env
 * values. No live Cognito calls anywhere.
 */

const ENV_KEYS = [
  'NEXT_PUBLIC_COGNITO_USER_POOL_ID',
  'NEXT_PUBLIC_COGNITO_CLIENT_ID',
  'NEXT_PUBLIC_AWS_REGION'
] as const

describe('resolveAuthConfig', () => {
  test('returns undefined (local mode) when no vars are set', () => {
    // Act
    const config = resolveAuthConfig({})

    // Assert
    expect(config).toBeUndefined()
  })

  test('returns undefined when only the user pool id is set', () => {
    // Act
    const config = resolveAuthConfig({ userPoolId: 'us-east-1_Abc123' })

    // Assert
    expect(config).toBeUndefined()
  })

  test('returns undefined when only the client id is set', () => {
    // Act
    const config = resolveAuthConfig({ userPoolClientId: 'client-123' })

    // Assert
    expect(config).toBeUndefined()
  })

  test('treats blank values as unset', () => {
    // Act
    const config = resolveAuthConfig({ userPoolId: '   ', userPoolClientId: 'client-123' })

    // Assert
    expect(config).toBeUndefined()
  })

  test('resolves a full config and defaults the region to us-east-1', () => {
    // Act
    const config = resolveAuthConfig({
      userPoolId: 'us-east-1_Abc123',
      userPoolClientId: 'client-123'
    })

    // Assert
    expect(config).toEqual({
      userPoolId: 'us-east-1_Abc123',
      userPoolClientId: 'client-123',
      region: DEFAULT_AWS_REGION
    })
  })

  test('honors an explicit region and trims whitespace', () => {
    // Act
    const config = resolveAuthConfig({
      userPoolId: ' us-west-2_Xyz789 ',
      userPoolClientId: ' client-456 ',
      region: ' us-west-2 '
    })

    // Assert
    expect(config).toEqual({
      userPoolId: 'us-west-2_Xyz789',
      userPoolClientId: 'client-456',
      region: 'us-west-2'
    })
  })
})

describe('getAuthConfig / isAuthConfigured (process.env)', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test('local mode when the Cognito vars are absent', () => {
    // Assert
    expect(getAuthConfig()).toBeUndefined()
    expect(isAuthConfigured()).toBe(false)
  })

  test('configured mode when both Cognito vars are present', () => {
    // Arrange
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = 'us-east-1_Abc123'
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = 'client-123'

    // Act
    const config = getAuthConfig()

    // Assert
    expect(isAuthConfigured()).toBe(true)
    expect(config).toEqual({
      userPoolId: 'us-east-1_Abc123',
      userPoolClientId: 'client-123',
      region: DEFAULT_AWS_REGION
    })
  })
})

describe('startBuildingHref', () => {
  test('sends visitors to /login when Cognito is configured', () => {
    expect(startBuildingHref(true)).toBe('/login')
  })

  test('sends visitors straight to /ideas in local mode', () => {
    expect(startBuildingHref(false)).toBe('/ideas')
  })
})
