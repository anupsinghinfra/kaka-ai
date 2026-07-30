import { Aspects, type App } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { PipelineStack } from './pipelines/pipeline-stack'
import { loadPlatformConfig, type PlatformConfig } from './platform-config'
import { ProdStage } from './prod-stage'

/**
 * Wires the CDK app from context (extracted from bin/platform.ts so tests can
 * exercise the real entry-point logic):
 *
 * - `deployVia=direct` (default): the bare prod Stage, for `cdk deploy`.
 * - `deployVia=pipeline`: the self-mutating pipeline stack, which contains
 *   the same prod Stage (EXECUTION.md M0 item 1).
 */
export function configurePlatformApp(app: App): PlatformConfig {
  const config = loadPlatformConfig(app)
  const env = { account: config.prodAccount, region: config.prodRegion }

  if (config.deployVia === 'pipeline') {
    new PipelineStack(app, 'PlatformPipeline', { config, env })
  } else {
    new ProdStage(app, 'prod', { config, env })
  }

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

  return config
}
