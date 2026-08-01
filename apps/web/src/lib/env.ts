/**
 * Repo-root .env loading for the web app — mirrors the scripts/venture
 * loader: values already in the environment always win; the file only fills
 * gaps. Values are never logged and never reach the browser.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
 * Walks up from `startDir` looking for pnpm-workspace.yaml (the monorepo
 * root marker). Returns undefined when no root is found.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let current = startDir
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    current = parent
  }
}

let hasLoaded = false

/**
 * Loads the repo-root .env into process.env once per process (non-overriding).
 * Safe to call from every request path. Missing file is fine — real env wins
 * and may already carry everything needed.
 */
export function loadRepoEnv(): void {
  if (hasLoaded) {
    return
  }
  hasLoaded = true
  const root = findRepoRoot(process.cwd())
  if (root === undefined) {
    return
  }
  const envPath = join(root, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') {
      return
    }
    throw error
  }
  applyMissingEnvVars(parseEnvFile(content), process.env)
}
