import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { eventEnvelopeSchema, type EventEnvelope } from '@platform/contracts'
import { EventValidationError } from './errors'
import { logger } from './logger'

function createEnvelopeValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true })
  addFormats(ajv)
  return ajv.compile(eventEnvelopeSchema)
}

/** Compiled once per process — Ajv compilation is expensive. */
const validateEnvelope: ValidateFunction = createEnvelopeValidator()

/**
 * Validates an envelope against `contracts/events/envelope.schema.json`
 * (draft 2020-12, same validator setup as the contracts tests). Throws a
 * typed `EventValidationError` with the Ajv errors attached — invalid events
 * are never silently dropped or sent.
 */
export function assertValidEnvelope(envelope: EventEnvelope): void {
  // Captured before the Ajv type guard runs — the guard narrows `envelope`
  // to `never` in the failure branch.
  const { type: eventType, ventureId } = envelope

  if (validateEnvelope(envelope)) {
    return
  }

  const errors = [...(validateEnvelope.errors ?? [])]
  const summary = errors.map((error) => `${error.instancePath || '/'}: ${error.message ?? 'invalid'}`).join('; ')

  logger.warn({ eventType, ventureId, validationErrors: errors }, 'event envelope failed schema validation')

  throw new EventValidationError(`Event envelope failed schema validation: ${summary}`, errors)
}
