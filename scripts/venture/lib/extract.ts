/**
 * Tolerant extraction of values from OnCell request-helper results. The
 * public API does not pin the request-method response shapes, so these
 * helpers accept the plausible encodings (bare value, {content}/{value}
 * field, or the same nested under a {result} envelope).
 */

/** Narrowing guard for plain objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapResult(value: unknown): unknown {
  if (isRecord(value) && 'result' in value) {
    return value['result']
  }
  return value
}

/** Extracts file content from a read_file result; undefined when absent. */
export function extractFileContent(result: unknown): string | undefined {
  const unwrapped = unwrapResult(result)
  if (typeof unwrapped === 'string') {
    return unwrapped
  }
  if (isRecord(unwrapped) && typeof unwrapped['content'] === 'string') {
    return unwrapped['content']
  }
  return undefined
}

/** Extracts the stored value from a db_get result. */
export function extractKvValue(result: unknown): unknown {
  const unwrapped = unwrapResult(result)
  if (isRecord(unwrapped) && 'value' in unwrapped) {
    return unwrapped['value']
  }
  return unwrapped
}
