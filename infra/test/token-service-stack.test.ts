import { App, Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import {
  POLICIES_TABLE_NAME_PARAMETER,
  TOKEN_SERVICE_ENDPOINT_PARAMETER,
  TOKEN_SIGNING_KEY_ARN_PARAMETER,
  TokenServiceStack
} from '../lib/primitives/secrets/token-service-stack'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }

let template: Template

beforeAll(() => {
  // Arrange (once — synth bundles the Lambda, so share the template)
  const app = new App()
  const stack = new TokenServiceStack(app, 'TestTokenService', { env: TEST_ENV })

  // Act
  template = Template.fromStack(stack)
})

describe('TokenServiceStack — KMS signing key', () => {
  test('creates an asymmetric RSA_2048 SIGN_VERIFY key that is retained', () => {
    // Assert
    template.hasResource('AWS::KMS::Key', {
      Properties: {
        KeySpec: 'RSA_2048',
        KeyUsage: 'SIGN_VERIFY'
      },
      DeletionPolicy: 'Retain'
    })
  })

  test('aliases the signing key', () => {
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/platform/token-signing'
    })
  })
})

describe('TokenServiceStack — policies table', () => {
  test('creates the policies table keyed by principalId with PITR, on-demand billing, and encryption', () => {
    // Assert
    template.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        TableName: 'policies',
        KeySchema: [{ AttributeName: 'principalId', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'principalId', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
        DeletionProtectionEnabled: true
      },
      DeletionPolicy: 'Retain'
    })
  })

  test('honors a custom table name via props', () => {
    // Arrange
    const app = new App()
    const stack = new TokenServiceStack(app, 'CustomTableStack', {
      env: TEST_ENV,
      policiesTableName: 'policies-custom'
    })

    // Act + Assert
    Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'policies-custom'
    })
  })
})

describe('TokenServiceStack — issuance Lambda', () => {
  test('runs Node 20 with the environment contract wired to the key and table', () => {
    // Assert
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          POLICIES_TABLE_NAME: { Ref: Match.stringLikeRegexp('PoliciesTable') },
          SIGNING_KEY_ID: { 'Fn::GetAtt': [Match.stringLikeRegexp('TokenSigningKey'), 'Arn'] },
          MAX_TOKEN_TTL_SECONDS: '900',
          DEFAULT_TOKEN_TTL_SECONDS: '300',
          LOG_LEVEL: 'info'
        })
      }
    })
  })

  test('may sign with the key and read the table, nothing broader', () => {
    // Assert: kms:Sign + kms:GetPublicKey scoped to the key
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['kms:Sign', 'kms:GetPublicKey'],
            Effect: 'Allow',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('TokenSigningKey'), 'Arn'] }
          })
        ])
      }
    })

    // Assert: no write-data grant on the table
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => (policy['Properties'] as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument.Statement
    )
    const flattenedActions = statements.flatMap((statement) => {
      const action = (statement as { Action: string | string[] }).Action
      return Array.isArray(action) ? action : [action]
    })
    expect(flattenedActions).not.toContain('dynamodb:PutItem')
    expect(flattenedActions).not.toContain('dynamodb:DeleteItem')
    expect(flattenedActions).not.toContain('kms:Decrypt')
  })

  test('rejects a default TTL above the max TTL at synth time', () => {
    // Arrange
    const app = new App()

    // Act + Assert
    expect(
      () =>
        new TokenServiceStack(app, 'BadTtlStack', {
          env: TEST_ENV,
          defaultTokenTtlSeconds: 600,
          maxTokenTtlSeconds: 300
        })
    ).toThrow('must not exceed')
  })
})

describe('TokenServiceStack — HTTP API', () => {
  test('exposes exactly one route: POST /tokens with IAM authorization', () => {
    // Assert
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1)
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /tokens',
      AuthorizationType: 'AWS_IAM'
    })
  })

  test('throttles and access-logs the default stage', () => {
    // Assert
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 100
      }),
      AccessLogSettings: Match.objectLike({
        DestinationArn: Match.anyValue()
      })
    })
  })
})

describe('TokenServiceStack — SSM outputs', () => {
  test('publishes the signing key ARN, API endpoint, and table name under /platform/secrets', () => {
    // Assert
    template.resourceCountIs('AWS::SSM::Parameter', 3)
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: TOKEN_SIGNING_KEY_ARN_PARAMETER,
      Type: 'String',
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('TokenSigningKey'), 'Arn'] }
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: TOKEN_SERVICE_ENDPOINT_PARAMETER,
      Type: 'String'
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: POLICIES_TABLE_NAME_PARAMETER,
      Type: 'String',
      Value: { Ref: Match.stringLikeRegexp('PoliciesTable') }
    })
  })
})

describe('TokenServiceStack — cdk-nag', () => {
  test('has no unsuppressed AwsSolutions findings', () => {
    // Arrange
    const app = new App()
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
    const stack = new TokenServiceStack(app, 'NagTokenService', { env: TEST_ENV })

    // Act
    Template.fromStack(stack)
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'))

    // Assert
    expect(errors.map((error) => error.entry.data)).toEqual([])
    expect(warnings.map((warning) => warning.entry.data)).toEqual([])
  })
})
