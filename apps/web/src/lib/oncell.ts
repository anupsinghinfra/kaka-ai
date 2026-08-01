/**
 * Server-side OnCell client access. ALL OnCell calls go through
 * @platform/oncell — the web app never fetches the OnCell API directly, and
 * the API key never reaches the browser (this module is only imported from
 * route handlers and server components).
 */

import { createOnCellClient, type OnCellClient } from '@platform/oncell'
import { loadRepoEnv } from './env'

let cachedClient: OnCellClient | undefined

/** Returns the shared OnCell client, loading the repo-root .env first. */
export function getOnCell(): OnCellClient {
  loadRepoEnv()
  if (cachedClient === undefined) {
    cachedClient = createOnCellClient()
  }
  return cachedClient
}

/**
 * True when the Builder can run. Agent mode (the default) needs only the
 * OnCell API key — the agent generates code through OnCell's metered LLM
 * gateway, so ANTHROPIC_API_KEY is merely the local-mode fallback.
 */
export function isBuilderConfigured(): boolean {
  loadRepoEnv()
  const key =
    process.env.KAKA_BUILDER_MODE === 'local'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.ONCELL_API_KEY
  return key !== undefined && key.length > 0
}

/** Test hook: reset the cached client (used by route tests). */
export function resetOnCellClientForTests(): void {
  cachedClient = undefined
}
