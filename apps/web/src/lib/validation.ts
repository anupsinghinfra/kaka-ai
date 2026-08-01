/**
 * Input validation for venture names and creation payloads. Fail fast with
 * clear messages at the API boundary.
 */

import { z } from 'zod'

export const VENTURE_NAME_MAX_LENGTH = 40

/** kebab-case: lowercase alphanumeric segments joined by single hyphens. */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const ventureNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(VENTURE_NAME_MAX_LENGTH, `name must be at most ${VENTURE_NAME_MAX_LENGTH} characters`)
  .regex(KEBAB_RE, 'name must be kebab-case (lowercase letters, digits, single hyphens)')

export const createVentureSchema = z.object({
  name: ventureNameSchema,
  idea: z.string().trim().max(2000, 'idea must be at most 2000 characters').optional()
})

export const forkVentureSchema = z.object({
  name: ventureNameSchema
})

export const execSchema = z.object({
  cmd: z.string().min(1, 'cmd is required').max(8192, 'cmd must be at most 8192 characters'),
  timeoutMs: z.number().int().positive().max(600_000).optional()
})

export type CreateVentureInput = z.infer<typeof createVentureSchema>
export type ForkVentureInput = z.infer<typeof forkVentureSchema>
export type ExecRequestInput = z.infer<typeof execSchema>

/** Customer id convention for OnCell cells backing ventures. */
export function ventureCustomerId(name: string): string {
  return `v-${name}`
}
