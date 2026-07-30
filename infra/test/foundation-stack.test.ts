import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { FoundationStack } from '../lib/foundation/foundation-stack'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }
const TEST_DOMAIN = 'example.app'

function synthesizeFoundationTemplate(): Template {
  // Arrange
  const app = new App()
  const stack = new FoundationStack(app, 'TestFoundation', {
    env: TEST_ENV,
    platformDomain: TEST_DOMAIN
  })

  // Act
  return Template.fromStack(stack)
}

describe('FoundationStack', () => {
  test('publishes the platform domain as an SSM string parameter', () => {
    const template = synthesizeFoundationTemplate()

    // Assert
    template.resourceCountIs('AWS::SSM::Parameter', 1)
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/platform/foundation/platform-domain',
      Type: 'String',
      Value: TEST_DOMAIN
    })
  })
})
