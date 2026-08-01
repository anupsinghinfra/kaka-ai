/**
 * Helpers over POST /api/v1/cells/{id}/request — the in-cell RPC surface
 * (files, KV, journal, logs, metrics).
 *
 * All request methods are marked idempotent for the 502/503 single retry:
 * reads trivially so; write_file is a full-content overwrite and db_set an
 * absolute value write, so replaying either yields the same end state.
 */

import { sendRequest, type HttpConfig } from './http'
import type { CellRequestMethod, KvGetResult, ListFilesResult, ReadFileResult } from './types'
import { requireNonEmptyString } from './validate'

/** The request-based sub-API mixed into the client. */
export interface RequestApi {
  request<T = unknown>(
    cellId: string,
    method: CellRequestMethod,
    params?: Readonly<Record<string, unknown>>
  ): Promise<T>
  writeFile(cellId: string, path: string, content: string): Promise<unknown>
  readFile(cellId: string, path: string): Promise<ReadFileResult>
  listFiles(cellId: string, path?: string): Promise<ListFilesResult>
  kvGet(cellId: string, key: string): Promise<KvGetResult>
  kvSet(cellId: string, key: string, value: unknown): Promise<unknown>
  journal(cellId: string): Promise<unknown>
  logs(cellId: string, lines?: number): Promise<unknown>
  metrics(cellId: string): Promise<unknown>
}

/** Builds the request helpers bound to a transport config. */
export function createRequestApi(config: HttpConfig): RequestApi {
  async function request<T = unknown>(
    cellId: string,
    method: CellRequestMethod,
    params: Readonly<Record<string, unknown>> = {}
  ): Promise<T> {
    requireNonEmptyString(cellId, 'cellId')
    const result = await sendRequest<T>(config, {
      method: 'POST',
      path: `/api/v1/cells/${encodeURIComponent(cellId)}/request`,
      body: { method, params },
      idempotent: true
    })
    return result.data
  }

  return {
    request,

    async writeFile(cellId: string, path: string, content: string): Promise<unknown> {
      requireNonEmptyString(path, 'path')
      if (typeof content !== 'string') {
        throw new TypeError('content must be a string')
      }
      return request(cellId, 'write_file', { path, content })
    },

    async readFile(cellId: string, path: string): Promise<ReadFileResult> {
      requireNonEmptyString(path, 'path')
      return request<ReadFileResult>(cellId, 'read_file', { path })
    },

    listFiles(cellId: string, path?: string): Promise<ListFilesResult> {
      return request<ListFilesResult>(cellId, 'list_files', path !== undefined ? { path } : {})
    },

    async kvGet(cellId: string, key: string): Promise<KvGetResult> {
      requireNonEmptyString(key, 'key')
      return request<KvGetResult>(cellId, 'db_get', { key })
    },

    async kvSet(cellId: string, key: string, value: unknown): Promise<unknown> {
      requireNonEmptyString(key, 'key')
      return request(cellId, 'db_set', { key, value })
    },

    journal(cellId: string): Promise<unknown> {
      return request(cellId, 'journal')
    },

    logs(cellId: string, lines?: number): Promise<unknown> {
      return request(cellId, 'logs', lines !== undefined ? { lines } : {})
    },

    metrics(cellId: string): Promise<unknown> {
      return request(cellId, 'metrics')
    }
  }
}
