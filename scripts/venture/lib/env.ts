/**
 * Minimal .env loading for scripts — no dotenv dependency. Values already in
 * the environment always win; the file only fills gaps. Values are never
 * logged.
 */

import { readFileSync } from 'node:fs'

/** Parses KEY=VALUE lines; skips comments/blank lines; strips matched quotes. */
export function parseEnvFile(content: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    if (isQuoted) {
      value = value.slice(1, -1)
    }
    entries[key] = value
  }
  return entries
}

/** Applies parsed vars to `env`, never overriding keys that are already set. */
export function applyMissingEnvVars(
  vars: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv
): void {
  for (const [key, value] of Object.entries(vars)) {
    if (env[key] === undefined) {
      env[key] = value
    }
  }
}

/**
 * Loads a .env file into `env` (non-overriding). Returns false when the file
 * does not exist; other read errors propagate.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    // Structural check (not instanceof): fs errors can cross VM realms.
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
  applyMissingEnvVars(parseEnvFile(content), env)
  return true
}
