/** Structured JSON logging via pino (no transports — CloudWatch captures stdout). */

import pino, { type Logger } from 'pino'

export type { Logger }

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'token-service' },
    timestamp: pino.stdTimeFunctions.isoTime
  })
}
