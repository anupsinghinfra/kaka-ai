/**
 * Request parsing and validation for registry routes.
 * All input is untrusted: schema-validate before any business logic runs.
 */

import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, VENTURE_ID_PATTERN } from './config'
import { RegistryError } from './errors'
import type { OwnerIndexKey } from './types'

/** Owner identifiers: bounded, printable, no whitespace or control chars. */
const OWNER_ID_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/

const manifestValueSchema = z.record(z.unknown())

const createVentureRequestSchema = z
  .object({
    manifest: manifestValueSchema
  })
  .strict()

export interface CreateVentureRequest {
  readonly manifest: Readonly<Record<string, unknown>>
}

const updateManifestRequestSchema = z
  .object({
    manifest: manifestValueSchema,
    expectedVersion: z
      .number()
      .int('expectedVersion must be an integer')
      .min(1, 'expectedVersion must be at least 1')
  })
  .strict()

export interface UpdateManifestRequest {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly expectedVersion: number
}

export function parseCreateVentureRequest(
  body: string | undefined,
  isBase64Encoded: boolean
): CreateVentureRequest {
  return parseBody(
    body,
    isBase64Encoded,
    createVentureRequestSchema,
    'Send JSON: { "manifest": <venture manifest without ventureId> }.'
  )
}

export function parseUpdateManifestRequest(
  body: string | undefined,
  isBase64Encoded: boolean
): UpdateManifestRequest {
  return parseBody(
    body,
    isBase64Encoded,
    updateManifestRequestSchema,
    'Send JSON: { "manifest": <full venture manifest>, "expectedVersion": number }.'
  )
}

/** Validated `GET /ventures` query: owner filter, page size, cursor. */
export interface ListVenturesQuery {
  readonly ownerId?: string
  readonly limit: number
  readonly exclusiveStartKey?: OwnerIndexKey
}

export function parseListVenturesQuery(
  params: Readonly<Record<string, string | undefined>> | undefined
): ListVenturesQuery {
  const ownerId = params?.['ownerId']
  const rawLimit = params?.['limit']
  const rawCursor = params?.['cursor']

  if (ownerId !== undefined && !OWNER_ID_PATTERN.test(ownerId)) {
    throw invalidRequest(
      'Query parameter "ownerId" must be 1-128 chars of [a-zA-Z0-9._:/-]',
      'Pass the owner principal id as issued by the token service, or omit it to list your own ventures.'
    )
  }

  return {
    ...(ownerId !== undefined ? { ownerId } : {}),
    limit: parseLimit(rawLimit),
    ...(rawCursor !== undefined ? { exclusiveStartKey: decodeCursor(rawCursor) } : {})
  }
}

/** Extracts and validates the `{ventureId}` path parameter. */
export function requireVentureIdParam(pathParameters: Readonly<Record<string, string | undefined>> | undefined): string {
  const ventureId = pathParameters?.['ventureId']

  if (ventureId === undefined || !VENTURE_ID_PATTERN.test(ventureId)) {
    throw invalidRequest(
      `Path parameter "ventureId" must match ${String(VENTURE_ID_PATTERN)}`,
      'Use the ventureId returned by POST /ventures (format: "venture-<lowercase alphanumeric/hyphens>").'
    )
  }

  return ventureId
}

const cursorSchema = z
  .object({
    ventureId: z.string().min(1),
    ownerId: z.string().min(1),
    createdAt: z.string().min(1)
  })
  .strict()

/** Encodes a DynamoDB GSI key as an opaque, URL-safe cursor. */
export function encodeCursor(key: OwnerIndexKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): OwnerIndexKey {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw invalidCursor()
  }

  const result = cursorSchema.safeParse(parsedJson)

  if (!result.success) {
    throw invalidCursor()
  }

  return result.data
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw invalidRequest(
      `Query parameter "limit" must be an integer between 1 and ${MAX_PAGE_SIZE}, got "${raw}"`,
      `Pass a limit between 1 and ${MAX_PAGE_SIZE}, or omit it for the default of ${DEFAULT_PAGE_SIZE}.`
    )
  }

  return parsed
}

function parseBody<T>(
  body: string | undefined,
  isBase64Encoded: boolean,
  schema: z.ZodType<T>,
  shapeHint: string
): T {
  if (body === undefined || body.length === 0) {
    throw invalidRequest('Request body is required', shapeHint)
  }

  const decoded = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(decoded)
  } catch {
    throw invalidRequest('Request body is not valid JSON', shapeHint)
  }

  const result = schema.safeParse(parsedJson)

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw invalidRequest(`Request validation failed — ${detail}`, shapeHint)
  }

  return result.data
}

function invalidCursor(): RegistryError {
  return invalidRequest(
    'Query parameter "cursor" is not a valid pagination cursor',
    'Pass the "nextCursor" value returned by a previous GET /ventures response, unmodified.'
  )
}

function invalidRequest(message: string, remediation: string): RegistryError {
  return new RegistryError('INVALID_REQUEST', 400, message, remediation)
}
