/**
 * Venture-manifest validation against `contracts/venture/venture.schema.json`
 * (draft 2020-12, same Ajv setup as `libs/events`). Invalid manifests produce
 * a 400 whose body carries the exact Ajv instance paths.
 */

import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { ventureManifestSchema, type VentureManifest } from '@platform/contracts'
import { RegistryError, type RegistryErrorDetail } from './errors'

function createManifestValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true })
  addFormats(ajv)
  return ajv.compile(ventureManifestSchema)
}

/** Compiled once per process — Ajv compilation is expensive. */
const validateManifest: ValidateFunction = createManifestValidator()

/**
 * Asserts `value` is a schema-valid venture manifest and returns it typed.
 * Throws `RegistryError` INVALID_MANIFEST (400) with per-path details.
 */
export function assertValidManifest(value: unknown): VentureManifest {
  if (validateManifest(value)) {
    return value as unknown as VentureManifest
  }

  const details: readonly RegistryErrorDetail[] = (validateManifest.errors ?? []).map((error) => ({
    path: error.instancePath.length > 0 ? error.instancePath : '/',
    message: error.message ?? 'invalid'
  }))

  const summary = details.map((detail) => `${detail.path}: ${detail.message}`).join('; ')

  throw new RegistryError(
    'INVALID_MANIFEST',
    400,
    `Venture manifest failed schema validation: ${summary}`,
    'Fix the listed manifest paths to conform to contracts/venture/venture.schema.json (v0) and resubmit.',
    details
  )
}
