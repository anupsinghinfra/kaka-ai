import { Stage, type StageProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { FoundationStack } from './foundation/foundation-stack'
import type { PlatformConfig } from './platform-config'
import { RegistryStack } from './control-plane/registry-stack'
import { AuthStack } from './foundation/auth-stack'
import { EventsStack } from './primitives/events/events-stack'
import { NetworkStack } from './primitives/network/network-stack'
import { TokenServiceStack } from './primitives/secrets/token-service-stack'

export interface ProdStageProps extends StageProps {
  readonly config: PlatformConfig
}

/**
 * The single prod stage (lean path: one environment, one account — see
 * EXECUTION.md §1). Wave 2 adds primitive and control-plane stacks here;
 * each new stack is instantiated in this stage with `env` inherited from
 * the stage.
 */
export class ProdStage extends Stage {
  constructor(scope: Construct, id: string, props: ProdStageProps) {
    super(scope, id, props)

    new FoundationStack(this, 'Foundation', {
      platformDomain: props.config.platformDomain
    })

    new AuthStack(this, 'Auth')

    const events = new EventsStack(this, 'Events')

    const tokenService = new TokenServiceStack(this, 'TokenService', {})

    new NetworkStack(this, 'Network', {
      platformDomain: props.config.platformDomain
    })

    // Registry reads the bus + signing-key SSM parameters at deploy time,
    // so those stacks must exist first.
    const registry = new RegistryStack(this, 'Registry', {})
    registry.addDependency(events)
    registry.addDependency(tokenService)
  }
}
