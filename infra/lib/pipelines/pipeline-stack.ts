import { Stack, type StackProps } from 'aws-cdk-lib'
import { BuildSpec, ComputeType, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild'
import { Pipeline, PipelineType } from 'aws-cdk-lib/aws-codepipeline'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'
import type { PipelinePlatformConfig } from '../platform-config'
import { ProdStage } from '../prod-stage'

/** SSM parameter paths this stack publishes (cross-stack contract; never Fn.importValue). */
export const PIPELINE_NAME_PARAMETER = '/platform/pipeline/name'
export const PIPELINE_ARN_PARAMETER = '/platform/pipeline/arn'

/** Single pipeline, `main → prod` (EXECUTION.md M0 item 1). */
export const PIPELINE_BRANCH = 'main'

/**
 * Post-deploy canary entry point. M0 ships a stub; M1 replaces the script
 * body with the real golden-path run (fork → build → preview → verify →
 * promote → rollback) without touching the pipeline shape (EXECUTION.md §1:
 * platform deploys complete only if the canary passes).
 */
export const CANARY_SCRIPT_PATH = 'scripts/canary/golden-path.sh'

/**
 * pnpm major pinned to the checked-in pnpm-lock.yaml (lockfileVersion 6.0 →
 * pnpm 8). Bump together with the lockfile.
 */
const PNPM_VERSION = '8.15.9'

/** Platform Node baseline (root package.json engines, Lambda runtimes). */
const NODE_RUNTIME_VERSION = '20'

export interface PipelineStackProps extends StackProps {
  readonly config: PipelinePlatformConfig
}

/**
 * Self-mutating CDK pipeline (EXECUTION.md M0 item 1): `main → prod` in the
 * single OnCell account, with the golden-path canary as the deploy gate.
 *
 * - Source: GitHub via a CodeStar/CodeConnections connection (ARN and
 *   `owner/repo` from context — see platform-config.ts).
 * - Synth: pnpm workspace install, full `pnpm -r build` + `pnpm -r test`
 *   (tests gate the pipeline — the repo's verification bar), then
 *   `cdk synth` in pipeline mode so self-mutation reproduces this app.
 * - Deploy: one wave containing the prod Stage — the same Stage `deployVia=
 *   direct` deploys, so both paths ship identical stacks.
 * - Post: the canary ShellStep. Deploys complete only if it exits 0.
 *
 * Docker stays disabled: token-service bundles with the workspace-local
 * esbuild (installed by `pnpm install`), so synth never falls back to the
 * bundling container.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props)

    const { config } = props

    const source = CodePipelineSource.connection(config.pipelineRepo, PIPELINE_BRANCH, {
      connectionArn: config.pipelineConnectionArn
    })

    const synth = new ShellStep('Synth', {
      input: source,
      installCommands: [
        'corepack enable',
        `corepack prepare pnpm@${PNPM_VERSION} --activate`,
        'pnpm install --frozen-lockfile'
      ],
      commands: [
        'pnpm -r build',
        'pnpm -r test',
        // Pipeline mode so the self-mutation step reproduces this exact app;
        // all other context comes from the committed infra/cdk.json.
        'pnpm --dir infra cdk synth --context deployVia=pipeline'
      ],
      primaryOutputDirectory: 'infra/cdk.out'
    })

    // Provided explicitly (rather than letting pipelines.CodePipeline create
    // it) solely to pin PipelineType.V2 — the current generation, which the
    // higher-level construct cannot set and otherwise warns about on every
    // synth. crossAccountKeys=false and restartExecutionOnUpdate=true mirror
    // what pipelines.CodePipeline would configure itself: single account, and
    // a self-mutated pipeline must re-run on its own update.
    const underlyingPipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: 'platform',
      pipelineType: PipelineType.V2,
      crossAccountKeys: false,
      restartExecutionOnUpdate: true
    })

    const pipeline = new CodePipeline(this, 'CdkPipeline', {
      codePipeline: underlyingPipeline,
      selfMutation: true,
      // Token-service bundling runs on local esbuild from the pnpm install;
      // enable only if a future asset genuinely needs a container.
      dockerEnabledForSynth: false,
      synth,
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxBuildImage.STANDARD_7_0,
          // pnpm -r build + test + synth across the workspace needs more
          // than the SMALL default.
          computeType: ComputeType.MEDIUM
        },
        partialBuildSpec: BuildSpec.fromObject({
          phases: {
            install: {
              'runtime-versions': { nodejs: NODE_RUNTIME_VERSION }
            }
          }
        })
      }
    })

    // Single wave, single prod stage — the lean path has no staging
    // (EXECUTION.md §1: previews + canary replace it).
    const prodWave = pipeline.addWave('Prod')
    prodWave.addStage(
      new ProdStage(this, 'prod', {
        config,
        env: { account: config.prodAccount, region: config.prodRegion }
      }),
      {
        post: [
          new ShellStep('GoldenPathCanary', {
            input: source,
            commands: [`bash ${CANARY_SCRIPT_PATH}`]
          })
        ]
      }
    )

    // Materialize the underlying CodePipeline so its name/ARN are readable
    // and generated resources exist for nag suppression.
    pipeline.buildPipeline()

    new StringParameter(this, 'PipelineNameParameter', {
      parameterName: PIPELINE_NAME_PARAMETER,
      description: 'Name of the self-mutating platform delivery pipeline (main → prod).',
      stringValue: pipeline.pipeline.pipelineName
    })

    new StringParameter(this, 'PipelineArnParameter', {
      parameterName: PIPELINE_ARN_PARAMETER,
      description: 'ARN of the self-mutating platform delivery pipeline (main → prod).',
      stringValue: pipeline.pipeline.pipelineArn
    })

    this.addNagSuppressions()
  }

  /**
   * Stack-level suppressions cover only findings produced by resources that
   * aws-cdk-lib/pipelines generates and manages (pipeline/action/CodeBuild
   * roles, the artifact bucket). Nothing in this stack hand-writes an IAM
   * policy; the stacks inside the prod Stage carry their own targeted
   * suppressions and are checked independently.
   */
  private addNagSuppressions(): void {
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK Pipelines-managed roles (pipeline, source/build actions, self-mutation, asset publishing) require wildcards scoped to the artifact bucket objects, cdk-assets targets, and CloudFormation deploy roles. These policies are generated and kept least-privilege by aws-cdk-lib/pipelines, not hand-written.'
      },
      {
        id: 'AwsSolutions-S1',
        reason:
          'The pipeline artifact bucket holds transient, reproducible build artifacts only; server access logs would add cost without audit value. Change history is auditable via CloudTrail and the pipeline execution record.'
      },
      {
        id: 'AwsSolutions-CB4',
        reason:
          'CodeBuild projects are generated by CDK Pipelines; artifacts use S3-managed (SSE-S3) encryption because this is a single-account pipeline (crossAccountKeys=false, deliberate — a dedicated CMK adds ~$1/month and rotation burden to protect reproducible build artifacts of a public-shape repo).'
      }
    ])
  }
}
