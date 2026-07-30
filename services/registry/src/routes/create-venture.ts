/**
 * `POST /ventures` — create a venture record.
 * Scope: `venture:create`. The registry assigns the ventureId; the caller
 * supplies the rest of the manifest, validated against the JSON Schema.
 */

import { randomUUID } from 'node:crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { requireScope } from '@platform/authorizer'
import { authenticate } from '../auth'
import { RegistryError } from '../errors'
import { publishMutationEvent, VENTURE_CREATED_EVENT } from '../event-publish'
import { jsonResponse, ventureBody } from '../http'
import type { Logger } from '../logging'
import { assertValidManifest } from '../manifest-validation'
import { parseCreateVentureRequest } from '../request'
import type { HandlerDependencies, VentureRecord } from '../types'

export async function handleCreateVenture(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies,
  log: Logger
): Promise<APIGatewayProxyStructuredResultV2> {
  const verified = await authenticate(event, deps.getVerificationKey, deps.now)
  requireScope(verified, 'venture:create')

  const request = parseCreateVentureRequest(event.body, event.isBase64Encoded ?? false)

  if ('ventureId' in request.manifest) {
    throw new RegistryError(
      'INVALID_REQUEST',
      400,
      'ventureId is assigned by the registry and must not be supplied on create',
      'Omit "ventureId" from the manifest; the registry generates it and returns the full record.'
    )
  }

  const generateVentureId = deps.generateVentureId ?? defaultGenerateVentureId
  const ventureId = generateVentureId()
  const manifest = assertValidManifest({ ...request.manifest, ventureId })

  const now = currentTimestamp(deps)
  const record: VentureRecord = {
    ventureId,
    ownerId: verified.sub,
    status: 'active',
    version: 1,
    manifest,
    createdAt: now,
    updatedAt: now
  }

  await deps.ventures.create(record)
  log.info({ ventureId, ownerId: record.ownerId, principal: verified.sub }, 'venture created')

  const warnings = await publishMutationEvent(
    deps.publisher,
    {
      type: VENTURE_CREATED_EVENT,
      ventureId,
      payload: {
        ventureId,
        ownerId: record.ownerId,
        version: record.version,
        manifest: manifest as unknown as Record<string, unknown>
      }
    },
    log
  )

  return jsonResponse(201, ventureBody(record, warnings))
}

function defaultGenerateVentureId(): string {
  return `venture-${randomUUID()}`
}

function currentTimestamp(deps: HandlerDependencies): string {
  return (deps.now ?? ((): Date => new Date()))().toISOString()
}
