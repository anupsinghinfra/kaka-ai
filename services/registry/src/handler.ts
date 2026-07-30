/**
 * Registry Lambda handler: routeKey dispatch + machine-readable error
 * mapping. Every route authenticates a capability token and enforces its
 * scope before touching the table (EXECUTION.md M0 exit criterion: scoped
 * call creates a record; unscoped call gets a machine-readable 403).
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { AuthorizationError } from '@platform/authorizer'
import { internalError, RegistryError } from './errors'
import { jsonResponse } from './http'
import type { Logger } from './logging'
import { handleCreateVenture } from './routes/create-venture'
import { handleDeleteVenture } from './routes/delete-venture'
import { handleGetVenture } from './routes/get-venture'
import { handleListVentures } from './routes/list-ventures'
import { handleUpdateManifest } from './routes/update-manifest'
import type { HandlerDependencies } from './types'

export type { HandlerDependencies } from './types'

export type RegistryHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

const SUPPORTED_ROUTES =
  'POST /ventures, GET /ventures, GET /ventures/{ventureId}, ' +
  'PUT /ventures/{ventureId}/manifest, DELETE /ventures/{ventureId}'

export function createRegistryHandler(deps: HandlerDependencies): RegistryHandler {
  return async (event) => {
    const log = deps.logger.child({
      requestId: event.requestContext?.requestId,
      routeKey: event.routeKey
    })

    try {
      return await dispatch(event, deps, log)
    } catch (error: unknown) {
      return toErrorResponse(error, log)
    }
  }
}

async function dispatch(
  event: APIGatewayProxyEventV2,
  deps: HandlerDependencies,
  log: Logger
): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.routeKey) {
    case 'POST /ventures':
      return handleCreateVenture(event, deps, log)
    case 'GET /ventures':
      return handleListVentures(event, deps)
    case 'GET /ventures/{ventureId}':
      return handleGetVenture(event, deps)
    case 'PUT /ventures/{ventureId}/manifest':
      return handleUpdateManifest(event, deps, log)
    case 'DELETE /ventures/{ventureId}':
      return handleDeleteVenture(event, deps, log)
    default:
      throw new RegistryError(
        'ROUTE_NOT_FOUND',
        404,
        `No registry route matches "${event.routeKey}"`,
        `Use one of: ${SUPPORTED_ROUTES}.`
      )
  }
}

function toErrorResponse(error: unknown, log: Logger): APIGatewayProxyStructuredResultV2 {
  if (error instanceof RegistryError) {
    log.warn({ code: error.code, statusCode: error.statusCode, reason: error.message }, 'registry request rejected')
    return jsonResponse(error.statusCode, error.toBody())
  }

  if (error instanceof AuthorizationError) {
    return authorizationErrorResponse(error, log)
  }

  log.error({ err: error }, 'unhandled error in registry handler')
  const fallback = internalError()
  return jsonResponse(fallback.statusCode, fallback.toBody())
}

function authorizationErrorResponse(error: AuthorizationError, log: Logger): APIGatewayProxyStructuredResultV2 {
  // Key resolution is a platform-side failure (KMS unreachable), not a
  // caller defect — do not blame the token.
  if (error.code === 'KEY_RESOLUTION_FAILED') {
    log.error({ code: error.code, reason: error.message }, 'verification key resolution failed')
    const fallback = internalError()
    return jsonResponse(fallback.statusCode, fallback.toBody())
  }

  const statusCode = error.code === 'SCOPE_DENIED' ? 403 : 401
  log.warn({ code: error.code, statusCode, reason: error.message }, 'capability token rejected')
  return jsonResponse(statusCode, error.toJSON())
}
