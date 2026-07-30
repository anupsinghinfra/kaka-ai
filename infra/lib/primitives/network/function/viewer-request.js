import cf from 'cloudfront';

// Viewer-request handler for the platform distribution.
//
// Resolves the Host header against the `routing-table` KeyValueStore:
//   - unknown host -> 404 JSON ({ error: { code: 'ROUTE_NOT_FOUND' } })
//     returned directly from the edge;
//   - known host   -> request passes through with the route target stashed
//     in the `x-route-target` header for the origin layer (M1 wires the
//     real cell-ingress origin selection).
//
// The pure decision logic is injected below at synth time from
// routing-decision.js (see network-stack.ts). Keep this wrapper free of
// logic so everything decision-shaped stays unit-testable in plain Node.

// __ROUTING_DECISION_SOURCE__

const kvs = cf.kvs();

async function lookupRoute(hostname) {
  try {
    return await kvs.get(hostname);
  } catch (error) {
    // kvs.get throws KeyNotFound for absent keys; treat every failure as
    // "no route" so the function fails closed with a 404.
    return null;
  }
}

// eslint-disable-next-line no-unused-vars -- entry point invoked by CloudFront
async function handler(event) {
  return routeRequest(event.request, lookupRoute);
}
