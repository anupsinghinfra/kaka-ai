/**
 * Test helper: a scripted fetch mock that records calls and replays a queue
 * of canned responses.
 */

import type { FetchLike, FetchRequestInit, FetchResponseLike } from '../../src/http'

export interface RecordedCall {
  readonly url: string
  readonly init: FetchRequestInit
}

export interface MockFetch {
  readonly fetchImpl: FetchLike
  readonly calls: readonly RecordedCall[]
}

/** Builds a FetchResponseLike serving a JSON body. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): FetchResponseLike {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => normalized.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body))
  }
}

/** Builds a FetchResponseLike serving a raw (possibly non-JSON) body. */
export function rawResponse(status: number, text: string): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: () => Promise.resolve(text)
  }
}

/**
 * Returns a fetch mock that shifts through `responses` in order (repeating
 * the last one) and records every call. A response entry that is an Error is
 * thrown instead (network failure simulation).
 */
export function createMockFetch(responses: readonly (FetchResponseLike | Error)[]): MockFetch {
  const calls: RecordedCall[] = []
  let index = 0

  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    const entry = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (entry instanceof Error) {
      return Promise.reject(entry)
    }
    return Promise.resolve(entry)
  }

  return { fetchImpl, calls }
}

/** Parses the JSON body a recorded call sent, asserting it exists. */
export function sentBody(call: RecordedCall): Record<string, unknown> {
  if (call.init.body === undefined) {
    throw new Error('expected the call to have a body')
  }
  return JSON.parse(call.init.body) as Record<string, unknown>
}
