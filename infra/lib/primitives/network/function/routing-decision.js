'use strict';

// Pure routing-decision logic for the viewer-request CloudFront Function.
//
// This file must stay dependency-free: it is injected into the CloudFront
// Function source at synth time (see network-stack.ts) and unit-tested in
// plain Node via the module.exports guard at the bottom. The CloudFront
// Functions runtime (cloudfront-js-2.0) has no `module`, so the guard is
// inert at the edge.

const ROUTE_TARGET_HEADER = 'x-route-target';
const MAX_HOSTNAME_LENGTH = 253;

/** Builds the machine-readable 404 returned for hosts with no routing entry. */
function buildNotFoundResponse() {
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'no-store' }
    },
    body: JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND' } })
  };
}

/**
 * Normalizes a raw Host header value into a routing-table key:
 * lowercased, port stripped. Returns null when unusable.
 */
function normalizeHost(rawHost) {
  if (typeof rawHost !== 'string' || rawHost.length === 0) {
    return null;
  }

  let host = rawHost.toLowerCase();
  const portIndex = host.indexOf(':');
  if (portIndex !== -1) {
    host = host.slice(0, portIndex);
  }

  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) {
    return null;
  }

  return host;
}

/**
 * Decides what to do with a viewer request.
 *
 * @param request CloudFront Functions request object.
 * @param lookupRoute async (hostname) => target string, or null when absent.
 * @returns Either a 404 response object (unknown host, fail-closed) or a new
 *          request object carrying the route target in ROUTE_TARGET_HEADER
 *          for the origin layer. The input request is never mutated.
 */
async function routeRequest(request, lookupRoute) {
  const hostHeader = request.headers && request.headers.host;
  const host = normalizeHost(hostHeader && hostHeader.value);
  if (host === null) {
    return buildNotFoundResponse();
  }

  let target = null;
  try {
    target = await lookupRoute(host);
  } catch (error) {
    // Fail closed: an unreadable routing table serves no routes.
    target = null;
  }

  if (typeof target !== 'string' || target.length === 0) {
    return buildNotFoundResponse();
  }

  const headers = Object.assign({}, request.headers);
  headers[ROUTE_TARGET_HEADER] = { value: target };
  return Object.assign({}, request, { headers: headers });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ROUTE_TARGET_HEADER: ROUTE_TARGET_HEADER,
    buildNotFoundResponse: buildNotFoundResponse,
    normalizeHost: normalizeHost,
    routeRequest: routeRequest
  };
}
