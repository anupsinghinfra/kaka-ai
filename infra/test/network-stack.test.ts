import { App, Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { NetworkStack } from '../lib/primitives/network/network-stack'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }
const TEST_DOMAIN = 'example.app'

interface CloudFrontHeaderValue {
  readonly value: string
}

interface CloudFrontRequest {
  method: string
  uri: string
  headers: Record<string, CloudFrontHeaderValue>
}

interface CloudFrontResponse {
  statusCode: number
  statusDescription: string
  headers: Record<string, CloudFrontHeaderValue>
  body: string
}

type LookupRoute = (hostname: string) => Promise<string | null>

interface RoutingDecisionModule {
  readonly ROUTE_TARGET_HEADER: string
  buildNotFoundResponse(): CloudFrontResponse
  normalizeHost(rawHost: unknown): string | null
  routeRequest(
    request: CloudFrontRequest,
    lookupRoute: LookupRoute
  ): Promise<CloudFrontRequest | CloudFrontResponse>
}

// Checked-in CloudFront Function source, loadable in plain Node via its
// module.exports guard (the CF wrapper with `import cf from 'cloudfront'`
// is intentionally not imported here).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const decision = require('../lib/primitives/network/function/routing-decision.js') as RoutingDecisionModule

function buildRequest(host?: string): CloudFrontRequest {
  const headers: Record<string, CloudFrontHeaderValue> = {}
  if (host !== undefined) {
    headers.host = { value: host }
  }

  return { method: 'GET', uri: '/', headers }
}

function isResponse(result: CloudFrontRequest | CloudFrontResponse): result is CloudFrontResponse {
  return 'statusCode' in result
}

function synthesizeNetworkStack(): { stack: NetworkStack; template: Template } {
  // Arrange
  const app = new App()
  const stack = new NetworkStack(app, 'TestNetwork', {
    env: TEST_ENV,
    platformDomain: TEST_DOMAIN
  })

  // Act
  return { stack, template: Template.fromStack(stack) }
}

describe('routing decision function', () => {
  test('passes a known host through with the route target header set', async () => {
    // Arrange
    const request = buildRequest('deploy-1.venture.example.app')
    const lookupRoute: LookupRoute = async () => 'cell-abc.ingress.internal:8443'

    // Act
    const result = await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(isResponse(result)).toBe(false)
    const routed = result as CloudFrontRequest
    expect(routed.headers[decision.ROUTE_TARGET_HEADER]).toEqual({
      value: 'cell-abc.ingress.internal:8443'
    })
    expect(routed.headers.host).toEqual({ value: 'deploy-1.venture.example.app' })
  })

  test('does not mutate the original request when routing', async () => {
    // Arrange
    const request = buildRequest('venture.example.app')
    const lookupRoute: LookupRoute = async () => 'cell-1.internal'

    // Act
    await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(request.headers[decision.ROUTE_TARGET_HEADER]).toBeUndefined()
  })

  test('normalizes the host header (case and port) before lookup', async () => {
    // Arrange
    const request = buildRequest('Deploy-1.Venture.EXAMPLE.APP:443')
    const seenKeys: string[] = []
    const lookupRoute: LookupRoute = async (hostname) => {
      seenKeys.push(hostname)
      return 'cell-1.internal'
    }

    // Act
    await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(seenKeys).toEqual(['deploy-1.venture.example.app'])
  })

  test('returns a machine-readable 404 when the host has no route', async () => {
    // Arrange
    const request = buildRequest('unknown.example.app')
    const lookupRoute: LookupRoute = async () => null

    // Act
    const result = await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(isResponse(result)).toBe(true)
    const response = result as CloudFrontResponse
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toEqual({ value: 'application/json' })
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'ROUTE_NOT_FOUND' } })
  })

  test('returns 404 when the routing lookup throws (fail closed)', async () => {
    // Arrange
    const request = buildRequest('venture.example.app')
    const lookupRoute: LookupRoute = async () => {
      throw new Error('kvs unavailable')
    }

    // Act
    const result = await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(isResponse(result)).toBe(true)
    expect((result as CloudFrontResponse).statusCode).toBe(404)
  })

  test('returns 404 when the host header is missing', async () => {
    // Arrange
    const request = buildRequest()
    const lookupRoute: LookupRoute = async () => 'cell-1.internal'

    // Act
    const result = await decision.routeRequest(request, lookupRoute)

    // Assert
    expect(isResponse(result)).toBe(true)
    expect((result as CloudFrontResponse).statusCode).toBe(404)
  })

  test.each([
    ['Host.Example.APP', 'host.example.app'],
    ['host.example.app:8443', 'host.example.app'],
    ['', null],
    [undefined, null],
    [`${'a'.repeat(254)}.app`, null]
  ])('normalizeHost(%p) -> %p', (rawHost, expected) => {
    // Act
    const normalized = decision.normalizeHost(rawHost)

    // Assert
    expect(normalized).toBe(expected)
  })
})

describe('NetworkStack', () => {
  test('creates the public hosted zone for the platform domain', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: `${TEST_DOMAIN}.`
    })
  })

  test('requests a DNS-validated wildcard certificate covering apex and *', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: TEST_DOMAIN,
      SubjectAlternativeNames: [`*.${TEST_DOMAIN}`],
      ValidationMethod: 'DNS'
    })
  })

  test('creates the empty routing-table KeyValueStore', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.hasResourceProperties('AWS::CloudFront::KeyValueStore', {
      Name: 'routing-table'
    })
  })

  test('creates a js-2.0 viewer function associated with the KeyValueStore', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({
        Runtime: 'cloudfront-js-2.0',
        KeyValueStoreAssociations: [
          Match.objectLike({ KeyValueStoreARN: Match.anyValue() })
        ]
      })
    })
  })

  test('injects the routing decision source into the function code', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    const functions = template.findResources('AWS::CloudFront::Function')
    const codes = Object.values(functions).map(
      (resource) => (resource.Properties as { FunctionCode: string }).FunctionCode
    )
    expect(codes).toHaveLength(1)
    expect(codes[0]).toContain('cf.kvs()')
    expect(codes[0]).toContain('ROUTE_NOT_FOUND')
    expect(codes[0]).toContain(decision.ROUTE_TARGET_HEADER)
    expect(codes[0]).not.toContain('__ROUTING_DECISION_SOURCE__')
  })

  test('serves wildcard + apex aliases with the cert and viewer-request function', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.arrayWith([TEST_DOMAIN, `*.${TEST_DOMAIN}`]),
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
          SslSupportMethod: 'sni-only'
        }),
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' })
          ]
        }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 503,
            ResponsePagePath: '/parking/503.json'
          })
        ])
      })
    })
  })

  test('creates apex and wildcard alias records (A + AAAA) to the distribution', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    template.resourceCountIs('AWS::Route53::RecordSet', 4)
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `${TEST_DOMAIN}.`,
      Type: 'A',
      AliasTarget: Match.anyValue()
    })
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `*.${TEST_DOMAIN}.`,
      Type: 'AAAA',
      AliasTarget: Match.anyValue()
    })
  })

  test('publishes network outputs to SSM under /platform/network', () => {
    const { template } = synthesizeNetworkStack()

    // Assert
    const expectedParameterNames = [
      '/platform/network/hosted-zone-id',
      '/platform/network/hosted-zone-name',
      '/platform/network/certificate-arn',
      '/platform/network/distribution-id',
      '/platform/network/distribution-domain-name',
      '/platform/network/routing-table-kvs-id',
      '/platform/network/routing-table-kvs-arn',
      '/platform/network/route-target-header'
    ]

    for (const name of expectedParameterNames) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name })
    }
  })

  test('rejects deployment outside us-east-1', () => {
    // Arrange
    const app = new App()

    // Act + Assert
    expect(
      () =>
        new NetworkStack(app, 'WrongRegion', {
          env: { account: '111111111111', region: 'eu-west-1' },
          platformDomain: TEST_DOMAIN
        })
    ).toThrow(/us-east-1/)
  })

  test('is cdk-nag clean (no unsuppressed AwsSolutions errors)', () => {
    // Arrange
    const app = new App()
    const stack = new NetworkStack(app, 'NagNetwork', {
      env: TEST_ENV,
      platformDomain: TEST_DOMAIN
    })
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }))

    // Act
    const errors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*')
    )

    // Assert
    expect(errors).toEqual([])
  })
})
