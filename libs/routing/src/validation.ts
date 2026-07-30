import { HostnameValidationError, TargetValidationError } from './errors'

const MAX_HOSTNAME_LENGTH = 253
const MAX_LABEL_LENGTH = 63
const MIN_HOSTNAME_LABELS = 2
const MIN_TARGET_HOST_LABELS = 1
/** CloudFront KeyValueStore values are capped at 1 KB. */
const MAX_TARGET_LENGTH = 1024
const MIN_PORT = 1
const MAX_PORT = 65535

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const CONTROL_OR_WHITESPACE_PATTERN = /[\s\u0000-\u001f\u007f]/

const HOSTNAME_HINT =
  'Use a fully-qualified lowercase hostname like "deploy-1.venture.example.app": ' +
  'labels of 1-63 chars from [a-z0-9-], no leading/trailing hyphen, at most 253 chars total.'

const TARGET_HINT =
  'Use an http(s) URL like "https://cell-abc.ingress.internal:8443" or a ' +
  '"host" / "host:port" pair; at most 1024 characters (KVS value limit).'

/** Lowercases and trims a hostname so lookups and writes share one key form. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase()
}

function validateDnsName(name: string, minLabels: number): string | null {
  if (name.length === 0) {
    return 'it is empty'
  }
  if (name.length > MAX_HOSTNAME_LENGTH) {
    return `it is ${name.length} characters (max ${MAX_HOSTNAME_LENGTH})`
  }

  const labels = name.split('.')
  if (labels.length < minLabels) {
    return `it has ${labels.length} DNS label(s) (min ${minLabels})`
  }

  for (const label of labels) {
    if (label.length === 0) {
      return 'it contains an empty DNS label'
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return `label "${label}" is ${label.length} characters (max ${MAX_LABEL_LENGTH})`
    }
    if (!DNS_LABEL_PATTERN.test(label)) {
      return `label "${label}" violates lowercase DNS label rules`
    }
  }

  return null
}

/**
 * Asserts that a (normalized) hostname is a valid lowercase DNS name with at
 * least two labels. Throws `HostnameValidationError` with a remediation hint.
 */
export function assertValidHostname(hostname: string): void {
  const problem = validateDnsName(hostname, MIN_HOSTNAME_LABELS)
  if (problem !== null) {
    throw new HostnameValidationError(`Invalid hostname "${hostname}": ${problem}.`, HOSTNAME_HINT)
  }
}

function validateUrlTarget(target: string): string | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'it is not a parseable URL'
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `URL scheme "${url.protocol}" is not http/https`
  }
  if (url.hostname.length === 0) {
    return 'the URL has no hostname'
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return 'the URL must not embed credentials'
  }

  return null
}

function validateHostPortTarget(target: string): string | null {
  const parts = target.split(':')
  if (parts.length > 2) {
    return 'it has more than one ":" (expected "host" or "host:port")'
  }

  const [host, port] = parts
  const hostProblem = validateDnsName(host, MIN_TARGET_HOST_LABELS)
  if (hostProblem !== null) {
    return `host part is invalid: ${hostProblem}`
  }

  if (port !== undefined) {
    const portNumber = Number(port)
    if (!/^\d+$/.test(port) || portNumber < MIN_PORT || portNumber > MAX_PORT) {
      return `port "${port}" is not an integer in ${MIN_PORT}-${MAX_PORT}`
    }
  }

  return null
}

/**
 * Asserts that a route target is either an http(s) URL or a `host[:port]`
 * pair within the KVS value size limit. Throws `TargetValidationError`.
 */
export function assertValidTarget(target: string): void {
  let problem: string | null = null

  if (target.length === 0) {
    problem = 'it is empty'
  } else if (target.length > MAX_TARGET_LENGTH) {
    problem = `it is ${target.length} characters (max ${MAX_TARGET_LENGTH})`
  } else if (CONTROL_OR_WHITESPACE_PATTERN.test(target)) {
    problem = 'it contains whitespace or control characters'
  } else if (target.includes('://')) {
    problem = validateUrlTarget(target)
  } else {
    problem = validateHostPortTarget(target)
  }

  if (problem !== null) {
    throw new TargetValidationError(`Invalid route target "${target}": ${problem}.`, TARGET_HINT)
  }
}
