import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { AccountRecovery, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito'
import type { Construct } from 'constructs'

/**
 * Cognito user pool for the kaka web app (same auth pattern as JustCopy:
 * Amplify Authenticator against a Cognito pool). Email sign-up with
 * self-service registration; SPA client (no secret) for the Next.js app.
 */
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const userPool = new UserPool(this, 'Users', {
      userPoolName: 'kaka-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: false
      },
      removalPolicy: RemovalPolicy.RETAIN
    })

    const client = new UserPoolClient(this, 'WebClient', {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(8)
    })

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId })
    new CfnOutput(this, 'WebClientId', { value: client.userPoolClientId })
  }
}
