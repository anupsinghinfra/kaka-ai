import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Landing page — server-rendered marketing at "/". Rendered with
 * react-dom/server; next/link is stubbed to a plain anchor and the repo
 * .env loader is stubbed out so only the test-controlled process.env
 * decides local mode vs configured. No live Cognito calls.
 */

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : undefined} {...rest}>
      {children}
    </a>
  )
}))

vi.mock('@/lib/env', () => ({
  loadRepoEnv: () => undefined
}))

import LandingPage from '@/app/page'

const ENV_KEYS = [
  'NEXT_PUBLIC_COGNITO_USER_POOL_ID',
  'NEXT_PUBLIC_COGNITO_CLIENT_ID',
  'NEXT_PUBLIC_AWS_REGION'
] as const

describe('landing page', () => {
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

  test('renders the hero pitch and the three how-it-works steps', () => {
    // Act
    const html = renderToStaticMarkup(<LandingPage />)

    // Assert
    expect(html).toContain('Type your startup idea.')
    expect(html).toContain('Watch it become a product.')
    expect(html).toContain('keeps improving itself')
    expect(html).toContain('Type the idea')
    expect(html).toContain('kaka builds and proves v1')
    expect(html).toContain('It ships improvements on its own')
  })

  test('renders the iteration timeline mock with check badges', () => {
    // Act
    const html = renderToStaticMarkup(<LandingPage />)

    // Assert
    expect(html).toContain('Iteration timeline')
    expect(html).toContain('check passed')
    expect(html).toContain('v1')
    expect(html).toContain('v4')
  })

  test('points Start building at /ideas in local mode', () => {
    // Act
    const html = renderToStaticMarkup(<LandingPage />)

    // Assert
    expect(html).toContain('Start building')
    expect(html).toContain('href="/ideas"')
    expect(html).not.toContain('href="/login"')
  })

  test('points Start building at /login when Cognito is configured', () => {
    // Arrange
    process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID = 'us-east-1_Abc123'
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = 'client-123'

    // Act
    const html = renderToStaticMarkup(<LandingPage />)

    // Assert
    expect(html).toContain('href="/login"')
    expect(html).not.toContain('href="/ideas"')
  })
})
