import pino, { type Logger } from 'pino'

/**
 * Structured logger for the OnCell client. Quiet by default — enable with
 * ONCELL_LOG_LEVEL (or the platform-wide PLATFORM_LOG_LEVEL).
 */
export const logger: Logger = pino({
  name: '@platform/oncell',
  level: process.env.ONCELL_LOG_LEVEL ?? process.env.PLATFORM_LOG_LEVEL ?? 'silent'
})
