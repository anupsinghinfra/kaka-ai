import pino, { type Logger } from 'pino'

/** Structured logger for the events library. Level via PLATFORM_LOG_LEVEL. */
export const logger: Logger = pino({
  name: '@platform/events',
  level: process.env.PLATFORM_LOG_LEVEL ?? 'info'
})
