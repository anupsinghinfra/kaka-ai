/**
 * Input validation for idea names and creation payloads. Fail fast with
 * clear messages at the API boundary.
 */

import { z } from 'zod'

export const IDEA_NAME_MAX_LENGTH = 40
export const IDEA_TEXT_MAX_LENGTH = 2000

/** kebab-case: lowercase alphanumeric segments joined by single hyphens. */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const ideaNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(IDEA_NAME_MAX_LENGTH, `name must be at most ${IDEA_NAME_MAX_LENGTH} characters`)
  .regex(KEBAB_RE, 'name must be kebab-case (lowercase letters, digits, single hyphens)')

export const ideaTextSchema = z
  .string()
  .trim()
  .max(IDEA_TEXT_MAX_LENGTH, `idea must be at most ${IDEA_TEXT_MAX_LENGTH} characters`)

export const createIdeaSchema = z.object({
  name: ideaNameSchema,
  idea: ideaTextSchema.optional()
})

export const updateIdeaSchema = z.object({
  idea: ideaTextSchema.min(1, 'idea is required')
})

export const forkIdeaSchema = z.object({
  name: ideaNameSchema
})

export const execSchema = z.object({
  cmd: z.string().min(1, 'cmd is required').max(8192, 'cmd must be at most 8192 characters'),
  timeoutMs: z.number().int().positive().max(600_000).optional()
})

export type CreateIdeaInput = z.infer<typeof createIdeaSchema>
export type UpdateIdeaInput = z.infer<typeof updateIdeaSchema>
export type ForkIdeaInput = z.infer<typeof forkIdeaSchema>
export type ExecRequestInput = z.infer<typeof execSchema>

/**
 * Customer id convention for OnCell cells backing ideas. The historical
 * "v-" prefix stays for compatibility with existing cells.
 */
export function ideaCustomerId(name: string): string {
  return `v-${name}`
}
