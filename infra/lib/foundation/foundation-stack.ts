import { Stack, type StackProps } from 'aws-cdk-lib'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'

export interface FoundationStackProps extends StackProps {
  /** Apex domain the platform serves ventures under. */
  readonly platformDomain: string
}

/**
 * Foundation stack — placeholder for M0.
 *
 * Wave 2 replaces/extends this with the real foundation: hosted zone, ACM
 * wildcard cert, CloudFront distribution + KeyValueStore, observability and
 * security baseline. For now it publishes the platform domain to SSM so the
 * app synthesizes end to end and cross-stack consumers have a stable
 * parameter path to read (cross-stack references go via SSM, never
 * `Fn.importValue` — see PLAN.md §2).
 */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props)

    new StringParameter(this, 'PlatformDomainParameter', {
      parameterName: '/platform/foundation/platform-domain',
      description: 'Apex domain the venture platform serves under.',
      stringValue: props.platformDomain
    })
  }
}
