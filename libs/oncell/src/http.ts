/**
 * HTTP transport for the OnCell client: auth header, JSON codec, error
 * normalization, and the retry policy.
 *
 * Retry policy: exactly one retry, only on 502/503 (the host resume path can
 * 503 transiently), and only for requests marked idempotent. Non-idempotent
 * calls (e.g. exec without an idempotency key, snapshot) are never retried.
 */

import type { Logger } from 'pino'
import { OnCellApiError, parseApiError } from './errors'

/** Statuses eligible for the single retry (transient host resume path). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503])

/** Default backoff before the single retry. */
export const DEFAULT_RETRY_BACKOFF_MS = 250

/** Minimal structural view of a fetch Response (mock-friendly). */
export interface FetchResponseLike {
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** Request init shape the transport passes to fetch. */
export interface FetchRequestInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** Structural fetch signature — the global fetch satisfies this. */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>

/** Resolved transport configuration shared by all client methods. */
export interface HttpConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly fetchImpl: FetchLike
  readonly retryBackoffMs: number
  readonly logger: Logger
}

/** One API request. `idempotent` gates the 502/503 retry. */
export interface HttpRequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly idempotent: boolean
}

/** Parsed response plus replay metadata. */
export interface HttpResult<T> {
  readonly data: T
  /** True when the server set x-idempotent-replay. */
  readonly idempotentReplay: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function attempt(config: HttpConfig, spec: HttpRequestSpec): Promise<FetchResponseLike> {
  const url = `${config.baseUrl}${spec.path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {})
  }
  try {
    return await config.fetchImpl(url, {
      method: spec.method,
      headers,
      ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {})
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'network request failed'
    throw new OnCellApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: `${spec.method} ${spec.path}: ${message}`
    })
  }
}

function isReplay(response: FetchResponseLike): boolean {
  const value = response.headers.get('x-idempotent-replay')
  return value !== null && value !== '' && value !== 'false'
}

async function toResult<T>(response: FetchResponseLike): Promise<HttpResult<T>> {
  const text = await response.text()
  if (!response.ok) {
    throw parseApiError(response.status, text)
  }
  const data: T = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)
  return { data, idempotentReplay: isReplay(response) }
}

/**
 * Sends one request; on a 502/503 for an idempotent request, waits
 * `retryBackoffMs` and retries exactly once, then surfaces whatever the
 * second attempt returned.
 */
export async function sendRequest<T>(config: HttpConfig, spec: HttpRequestSpec): Promise<HttpResult<T>> {
  const first = await attempt(config, spec)
  if (!RETRYABLE_STATUSES.has(first.status) || !spec.idempotent) {
    return toResult<T>(first)
  }

  config.logger.warn(
    { path: spec.path, status: first.status, backoffMs: config.retryBackoffMs },
    'retrying OnCell request after transient status'
  )
  await sleep(config.retryBackoffMs)
  const second = await attempt(config, spec)
  return toResult<T>(second)
}
