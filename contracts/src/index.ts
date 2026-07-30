import ventureSchemaJson from '../venture/venture.schema.json'
import eventEnvelopeSchemaJson from '../events/envelope.schema.json'

export * from './types'

/** JSON Schema (draft 2020-12) for the venture manifest (venture.yaml v0). */
export const ventureManifestSchema: Readonly<Record<string, unknown>> = ventureSchemaJson

/** JSON Schema (draft 2020-12) for the platform event envelope. */
export const eventEnvelopeSchema: Readonly<Record<string, unknown>> = eventEnvelopeSchemaJson
