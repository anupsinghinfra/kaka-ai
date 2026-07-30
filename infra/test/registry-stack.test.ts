import { App, Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import {
  OWNER_INDEX_NAME,
  REGISTRY_API_ENDPOINT_PARAMETER,
  REGISTRY_TABLE_NAME_PARAMETER,
  RegistryStack
} from '../lib/control-plane/registry-stack'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }

let template: Template

beforeAll(() => {
  // Arrange (once — synth bundles the Lambda, so share the template)
  const app = new App()
  const stack = new RegistryStack(app, 'TestRegistry', { env: TEST_ENV })

  // Act
  template = Template.fromStack(stack)
})

describe('RegistryStack — ventures table', () => {
  test('creates the ventures table keyed by ventureId with PITR, on-demand billing, encryption, and retention', () => {
    // Assert
    template.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        TableName: 'ventures',
        KeySchema: [{ AttributeName: 'ventureId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
        DeletionProtectionEnabled: true
      },
      DeletionPolicy: 'Retain'
    })
  })

  test('indexes ventures by owner (ownerId + createdAt, all attributes projected)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: OWNER_INDEX_NAME,
          KeySchema: [
            { AttributeName: 'ownerId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        })
      ]
    })
  })

  test('honors a custom table name via props', () => {
    // Arrange
    const app = new App()
    const stack = new RegistryStack(app, 'CustomTableRegistry', {
      env: TEST_ENV,
      venturesTableName: 'ventures-custom'
    })

    // Act + Assert
    Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'ventures-custom'
    })
  })
})

describe('RegistryStack — handler Lambda', () => {
  test('runs Node 20 on ARM with the environment contract wired to table, bus, and signing key', () => {
    // Assert
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          VENTURES_TABLE_NAME: { Ref: Match.stringLikeRegexp('VenturesTable') },
          OWNER_INDEX_NAME: OWNER_INDEX_NAME,
          // Cross-stack values resolve through SSM parameter references.
          EVENT_BUS_NAME: { Ref: Match.stringLikeRegexp('SsmParameterValue.*platformeventsbusname.*') },
          SIGNING_KEY_ARN: { Ref: Match.stringLikeRegexp('SsmParameterValue.*tokensigningkeyarn.*') },
          LOG_LEVEL: 'info'
        })
      }
    })
  })

  test('may write the table, put events on the platform bus, and read the public key — nothing broader', () => {
    // Assert: PutEvents scoped to the bus ARN from SSM
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PublishPlatformEvents',
            Action: 'events:PutEvents',
            Effect: 'Allow',
            Resource: { Ref: Match.stringLikeRegexp('SsmParameterValue.*platformeventsbusarn.*') }
          }),
          Match.objectLike({
            Sid: 'ReadTokenVerificationKey',
            Action: 'kms:GetPublicKey',
            Effect: 'Allow',
            Resource: { Ref: Match.stringLikeRegexp('SsmParameterValue.*tokensigningkeyarn.*') }
          })
        ])
      }
    })

    // Assert: least privilege — the registry verifies tokens, never signs or
    // decrypts, and never administers the table.
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => (policy['Properties'] as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement
    )
    const flattenedActions = statements.flatMap((statement) => {
      const action = (statement as { Action: string | string[] }).Action
      return Array.isArray(action) ? action : [action]
    })
    expect(flattenedActions).not.toContain('kms:Sign')
    expect(flattenedActions).not.toContain('kms:Decrypt')
    expect(flattenedActions).not.toContain('dynamodb:DeleteTable')
    expect(flattenedActions).not.toContain('dynamodb:*')
    expect(flattenedActions).not.toContain('*')
  })
})

describe('RegistryStack — HTTP API', () => {
  test('exposes exactly the five registry routes', () => {
    // Assert
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 5)

    const routes = template.findResources('AWS::ApiGatewayV2::Route')
    const routeKeys = Object.values(routes).map(
      (route) => (route['Properties'] as { RouteKey: string }).RouteKey
    )
    expect(routeKeys.sort()).toEqual(
      [
        'POST /ventures',
        'GET /ventures',
        'GET /ventures/{ventureId}',
        'PUT /ventures/{ventureId}/manifest',
        'DELETE /ventures/{ventureId}'
      ].sort()
    )
  })

  test('uses app-layer capability-token authorization, not IAM, on every route', () => {
    // Assert: no route carries an AWS_IAM (or any) gateway authorizer —
    // capability JWTs are verified in the handler instead.
    const routes = template.findResources('AWS::ApiGatewayV2::Route')
    for (const route of Object.values(routes)) {
      const properties = route['Properties'] as { AuthorizationType?: string }
      expect(properties.AuthorizationType ?? 'NONE').toBe('NONE')
    }
  })

  test('throttles and access-logs the default stage', () => {
    // Assert
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 20,
        ThrottlingBurstLimit: 40
      }),
      AccessLogSettings: Match.objectLike({
        DestinationArn: Match.anyValue()
      })
    })
  })
})

describe('RegistryStack — SSM outputs', () => {
  test('publishes the API endpoint and table name under /platform/registry', () => {
    // Assert
    template.resourceCountIs('AWS::SSM::Parameter', 2)
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: REGISTRY_API_ENDPOINT_PARAMETER,
      Type: 'String'
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: REGISTRY_TABLE_NAME_PARAMETER,
      Type: 'String',
      Value: { Ref: Match.stringLikeRegexp('VenturesTable') }
    })
  })
})

describe('RegistryStack — cdk-nag', () => {
  test('has no unsuppressed AwsSolutions findings', () => {
    // Arrange
    const app = new App()
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
    const stack = new RegistryStack(app, 'NagRegistry', { env: TEST_ENV })

    // Act
    Template.fromStack(stack)
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'))

    // Assert
    expect(errors.map((error) => error.entry.data)).toEqual([])
    expect(warnings.map((warning) => warning.entry.data)).toEqual([])
  })
})
