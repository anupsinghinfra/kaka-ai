import { describe, expect, test } from 'vitest'
import {
  CHECK_OK_MARKER,
  REQUIRED_CHECK_PATH,
  REQUIRED_SERVER_PATH,
  builderSystemPrompt
} from '@/lib/builder/contract'
import { improveSystemPrompt } from '@/lib/builder/improve'

/**
 * The service contract inside the prompts: every generated app must be a
 * runnable HTTP server (src/server.js on process.env.PORT) whose self-test
 * talks to 127.0.0.1 — never "localhost" (the sandbox has no name
 * resolution).
 */

describe('builder system prompt (build)', () => {
  test('demands the HTTP server entry point on process.env.PORT', () => {
    // Act
    const prompt = builderSystemPrompt()

    // Assert
    expect(prompt).toContain(REQUIRED_SERVER_PATH)
    expect(prompt).toContain('process.env.PORT || 3000')
    expect(prompt).toContain(`node ${REQUIRED_SERVER_PATH}`)
  })

  test('demands a self-test over HTTP against 127.0.0.1, never localhost', () => {
    // Act
    const prompt = builderSystemPrompt()

    // Assert
    expect(prompt).toContain('127.0.0.1')
    expect(prompt).toContain('NEVER the hostname "localhost"')
    expect(prompt).toContain('ephemeral port')
    expect(prompt).toContain(REQUIRED_CHECK_PATH)
    expect(prompt).toContain(CHECK_OK_MARKER)
  })
})

describe('improver system prompt', () => {
  test('keeps the HTTP server entry point and the 127.0.0.1 self-test rule', () => {
    // Act
    const prompt = improveSystemPrompt()

    // Assert
    expect(prompt).toContain(REQUIRED_SERVER_PATH)
    expect(prompt).toContain('process.env.PORT || 3000')
    expect(prompt).toContain('127.0.0.1')
    expect(prompt).toContain('NEVER the hostname "localhost"')
  })
})
