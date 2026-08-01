import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Repo-root .env → process.env (non-overriding), mirroring src/lib/env.ts.
 * Next only auto-loads .env files from the app directory, but this monorepo
 * keeps its single .env at the root; applying it here makes NEXT_PUBLIC_*
 * values (the Cognito auth vars) visible to Next's build-time inlining for
 * the client bundle, in dev, build, and start alike.
 */
function applyRepoRootEnv() {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
  let content
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return // No root .env — real environment variables still apply.
  }
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
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

applyRepoRootEnv()

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OnCell/Anthropic calls happen exclusively in server route handlers;
  // nothing here is exposed to the browser.
  reactStrictMode: true,
  // Pin file tracing to the monorepo root (a stray lockfile in $HOME
  // otherwise makes Next guess the wrong workspace root).
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url))
}

export default nextConfig
