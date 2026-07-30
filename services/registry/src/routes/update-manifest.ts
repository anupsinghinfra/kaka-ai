/**
 * `PUT /ventures/{ventureId}/manifest` — replace the manifest.
 * Scope: `venture:write:{ventureId}`. Optimistic concurrency: the caller
 * sends `expectedVersion`; a mismatch (pre-check or write-time race) is a
 * 409 VERSION_CONFLICT with remediation.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { requireScope } from '@platform/authorizer'
import { authenticate } from '../auth'
import { RegistryError, ventureNotFound } from '../errors'
import { publishMutationEvent, VENTURE_MANIFEST_UPDATED_EVENT } from '../event-publish'
import { jsonResponse, ventureBody } from '../http'
import type { Logger } from '../logging'
import { assertValidManifest } from '../manifest-validation'
import { parseUpdateManifestRequest, requireVentureIdParam } from '../request'
import type { HandlerDependencies, VentureRecord } from '../types'

export async function handleUpdateManifest(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies,
  log: Logger
): Promise<APIGatewayProxyStructuredResultV2> {
  const verified = await authenticate(event, deps.getVerificationKey, deps.now)
  const ventureId = requireVentureIdParam(event.pathParameters)
  requireScope(verified, `venture:write:${ventureId}`)

  const request = parseUpdateManifestRequest(event.body, event.isBase64Encoded ?? false)
  const manifest = assertValidManifest(request.manifest)

  if (manifest.ventureId !== ventureId) {
    throw new RegistryError(
      'INVALID_REQUEST',
      400,
      `Manifest ventureId "${manifest.ventureId}" does not match the venture being updated ("${ventureId}")`,
      'Set manifest.ventureId to the path ventureId; venture ids are immutable.'
    )
  }

  const existing = await deps.ventures.findById(ventureId)

  if (existing === null) {
    throw ventureNotFound(ventureId)
  }

  if (existing.status === 'deleted') {
    throw new RegistryError(
      'VENTURE_DELETED',
      409,
      `Venture "${ventureId}" is deleted; its manifest cannot be updated`,
      'Deleted ventures are immutable. Create a new venture instead.'
    )
  }

  if (existing.version !== request.expectedVersion) {
    throw versionConflict(ventureId, request.expectedVersion, existing.version)
  }

  const next: VentureRecord = {
    ...existing,
    manifest,
    version: existing.version + 1,
    updatedAt: currentTimestamp(deps)
  }

  // Race window between the read above and this write is closed by the
  // conditional expression on `version` (store throws VERSION_CONFLICT).
  await deps.ventures.replace(next, request.expectedVersion)
  log.info({ ventureId, version: next.version, principal: verified.sub }, 'venture manifest updated')

  const warnings = await publishMutationEvent(
    deps.publisher,
    {
      type: VENTURE_MANIFEST_UPDATED_EVENT,
      ventureId,
      payload: {
        ventureId,
        ownerId: next.ownerId,
        version: next.version,
        manifest: manifest as unknown as Record<string, unknown>
      }
    },
    log
  )

  return jsonResponse(200, ventureBody(next, warnings))
}

function versionConflict(ventureId: string, expected: number, current: number): RegistryError {
  return new RegistryError(
    'VERSION_CONFLICT',
    409,
    `Venture "${ventureId}" is at version ${current}, but the request expected version ${expected}`,
    `GET the venture, rebase your manifest change on version ${current}, and retry with expectedVersion ${current}.`
  )
}

function currentTimestamp(deps: HandlerDependencies): string {
  return (deps.now ?? ((): Date => new Date()))().toISOString()
}
