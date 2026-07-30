import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {
  eventEnvelopeSchema,
  ventureManifestSchema,
  type EventEnvelope,
  type VentureManifest
} from '../src/index'

function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true })
  addFormats(ajv)
  return ajv
}

const VALID_MANIFEST: VentureManifest = {
  schemaVersion: '0',
  ventureId: 'venture-42',
  name: 'Example Venture',
  spec: { ref: 'docs/spec.md' },
  repo: { ref: 'fs://venture-42', defaultBranch: 'main' },
  db: { ref: 'db://venture-42', provider: 'embedded' },
  deployments: [
    {
      deployId: 'deploy-001',
      kind: 'preview',
      codeRef: 'branch-x',
      dbBranchRef: 'branch-x',
      url: 'https://deploy-001.venture-42.example.app'
    }
  ],
  budgets: { monthlyUsd: 100, perPrimitive: { email: 10 } }
}

const VALID_ENVELOPE: EventEnvelope = {
  id: '4b1c8f0a-0d5e-4c3b-9a2f-7e6d5c4b3a21',
  type: 'venture.created',
  ventureId: 'venture-42',
  timestamp: '2026-07-28T12:00:00Z',
  source: 'registry',
  payload: { name: 'Example Venture' }
}

describe('venture manifest schema', () => {
  test('is a compilable JSON Schema draft 2020-12 document', () => {
    const validate = createValidator().compile(ventureManifestSchema)
    expect(typeof validate).toBe('function')
  })

  test('accepts a valid v0 manifest', () => {
    const validate = createValidator().compile(ventureManifestSchema)
    expect(validate(VALID_MANIFEST)).toBe(true)
  })

  test('rejects a manifest missing budgets', () => {
    const validate = createValidator().compile(ventureManifestSchema)
    const { budgets: _omitted, ...withoutBudgets } = VALID_MANIFEST
    expect(validate(withoutBudgets)).toBe(false)
  })
})

describe('event envelope schema', () => {
  test('is a compilable JSON Schema draft 2020-12 document', () => {
    const validate = createValidator().compile(eventEnvelopeSchema)
    expect(typeof validate).toBe('function')
  })

  test('accepts a valid envelope', () => {
    const validate = createValidator().compile(eventEnvelopeSchema)
    expect(validate(VALID_ENVELOPE)).toBe(true)
  })

  test('rejects an envelope with an invalid event type', () => {
    const validate = createValidator().compile(eventEnvelopeSchema)
    expect(validate({ ...VALID_ENVELOPE, type: 'NotDotDelimited' })).toBe(false)
  })
})
