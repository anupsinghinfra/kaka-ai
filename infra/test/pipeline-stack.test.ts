import { App, Aspects, Stack, type Stage } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { configurePlatformApp } from '../lib/platform-app'
import {
  CANARY_SCRIPT_PATH,
  PIPELINE_ARN_PARAMETER,
  PIPELINE_BRANCH,
  PIPELINE_NAME_PARAMETER,
  PipelineStack
} from '../lib/pipelines/pipeline-stack'
import type { PipelinePlatformConfig } from '../lib/platform-config'

const TEST_ENV = { account: '111111111111', region: 'us-east-1' }

const PIPELINE_CONFIG: PipelinePlatformConfig = {
  deployVia: 'pipeline',
  prodAccount: TEST_ENV.account,
  prodRegion: TEST_ENV.region,
  platformDomain: 'example.app',
  pipelineConnectionArn: 'arn:aws:codeconnections:us-east-1:111111111111:connection/test',
  pipelineRepo: 'owner/repo'
}

const DIRECT_CONTEXT = {
  prodAccount: TEST_ENV.account,
  prodRegion: TEST_ENV.region,
  platformDomain: 'example.app',
  // cdk.json ships these as placeholders; direct mode must ignore them.
  pipelineConnectionArn: 'REPLACE_ME_CODECONNECTIONS_ARN',
  pipelineRepo: 'REPLACE_ME_GITHUB_OWNER_AND_REPO'
}

const EXPECTED_PROD_STACKS = ['Foundation', 'Auth', 'Events', 'TokenService', 'Network', 'Registry']

let template: Template

beforeAll(() => {
  // Arrange (once — the embedded ProdStage bundles the token-service Lambda
  // at synth, so share the template across assertions)
  const app = new App()
  const stack = new PipelineStack(app, 'TestPlatformPipeline', {
    config: PIPELINE_CONFIG,
    env: TEST_ENV
  })

  // Act
  template = Template.fromStack(stack)
})

/** Inline buildspecs of every generated CodeBuild project, as raw JSON strings. */
function findBuildSpecs(): string[] {
  const projects = template.findResources('AWS::CodeBuild::Project')

  return Object.values(projects)
    .map((project) => {
      const source = (project['Properties'] as { Source?: { BuildSpec?: unknown } }).Source
      return source?.BuildSpec
    })
    .filter((buildSpec): buildSpec is string => typeof buildSpec === 'string')
}

describe('PipelineStack — pipeline shape', () => {
  test('creates exactly one self-mutating pipeline named platform', () => {
    // Assert
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1)
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'platform',
      PipelineType: 'V2',
      Stages: Match.arrayWith([
        Match.objectLike({ Name: 'UpdatePipeline' }),
        Match.objectLike({ Name: 'prod' })
      ])
    })
  })

  test('sources from the CodeStar connection with the context repo on main', () => {
    // Assert
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'Source',
          Actions: [
            Match.objectLike({
              ActionTypeId: Match.objectLike({ Provider: 'CodeStarSourceConnection' }),
              Configuration: Match.objectLike({
                ConnectionArn: PIPELINE_CONFIG.pipelineConnectionArn,
                FullRepositoryId: PIPELINE_CONFIG.pipelineRepo,
                BranchName: PIPELINE_BRANCH
              })
            })
          ]
        })
      ])
    })
  })
})

describe('PipelineStack — synth step', () => {
  test('installs pnpm and runs the full workspace build, tests, and pipeline-mode synth', () => {
    // Act
    const buildSpecs = findBuildSpecs()
    const synthSpec = buildSpecs.find((buildSpec) => buildSpec.includes('pnpm -r build'))

    // Assert: tests gate the pipeline (the repo verification bar), and the
    // synth reproduces pipeline mode so self-mutation converges.
    expect(synthSpec).toBeDefined()
    expect(synthSpec).toContain('corepack enable')
    expect(synthSpec).toContain('pnpm install --frozen-lockfile')
    expect(synthSpec).toContain('pnpm -r test')
    expect(synthSpec).toContain('pnpm --dir infra cdk synth --context deployVia=pipeline')
  })

  test('builds on Node 20 without docker', () => {
    // Assert: every generated project pins the Node 20 runtime baseline
    const buildSpecs = findBuildSpecs()
    const synthSpec = buildSpecs.find((buildSpec) => buildSpec.includes('pnpm -r build'))
    expect(synthSpec).toContain('"nodejs": "20"')

    // Assert: no privileged (docker) build environments
    const projects = template.findResources('AWS::CodeBuild::Project')
    for (const project of Object.values(projects)) {
      const environment = (project['Properties'] as { Environment: { PrivilegedMode?: boolean } }).Environment
      expect(environment.PrivilegedMode ?? false).toBe(false)
    }
  })
})

describe('PipelineStack — prod deployment and canary gate', () => {
  test('deploys the prod stage stacks inside the pipeline', () => {
    // Assert: the prod pipeline stage deploys CloudFormation stacks
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'prod',
          Actions: Match.arrayWith([
            Match.objectLike({
              ActionTypeId: Match.objectLike({ Category: 'Deploy', Provider: 'CloudFormation' })
            })
          ])
        })
      ])
    })
  })

  test('runs the golden-path canary as a post-deploy gate in the prod stage', () => {
    // Assert: a CodeBuild step invokes the canary script
    const buildSpecs = findBuildSpecs()
    const canarySpec = buildSpecs.find((buildSpec) => buildSpec.includes(CANARY_SCRIPT_PATH))
    expect(canarySpec).toBeDefined()

    // Assert: the canary action lives in the prod stage, after the deploys
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'prod',
          Actions: Match.arrayWith([Match.objectLike({ Name: 'GoldenPathCanary' })])
        })
      ])
    })
  })
})

describe('PipelineStack — SSM outputs', () => {
  test('publishes the pipeline name and ARN under /platform/pipeline', () => {
    // Assert
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: PIPELINE_NAME_PARAMETER,
      Type: 'String',
      Value: { Ref: Match.stringLikeRegexp('Pipeline') }
    })
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: PIPELINE_ARN_PARAMETER,
      Type: 'String'
    })
  })
})

describe('PipelineStack — cdk-nag', () => {
  test('has no unsuppressed AwsSolutions findings', () => {
    // Arrange
    const app = new App()
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
    const stack = new PipelineStack(app, 'NagPlatformPipeline', {
      config: PIPELINE_CONFIG,
      env: TEST_ENV
    })

    // Act
    Template.fromStack(stack)
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'))

    // Assert
    expect(errors.map((error) => error.entry.data)).toEqual([])
    expect(warnings.map((warning) => warning.entry.data)).toEqual([])
  })
})

describe('platform app entry point — deployVia selection', () => {
  test('default context (deployVia=direct) produces the five prod stacks and no pipeline', () => {
    // Arrange
    const app = new App({ context: DIRECT_CONTEXT })

    // Act
    const config = configurePlatformApp(app)

    // Assert
    expect(config.deployVia).toBe('direct')
    expect(app.node.tryFindChild('PlatformPipeline')).toBeUndefined()

    const stage = app.node.tryFindChild('prod') as Stage
    expect(stage).toBeDefined()
    const stackIds = stage.node.children.filter(Stack.isStack).map((stack) => stack.node.id)
    expect(stackIds.sort()).toEqual([...EXPECTED_PROD_STACKS].sort())
  })

  test('deployVia=pipeline produces the pipeline stack containing the prod stage, and no bare stage', () => {
    // Arrange
    const app = new App({
      context: {
        ...DIRECT_CONTEXT,
        deployVia: 'pipeline',
        pipelineConnectionArn: PIPELINE_CONFIG.pipelineConnectionArn,
        pipelineRepo: PIPELINE_CONFIG.pipelineRepo
      }
    })

    // Act
    const config = configurePlatformApp(app)

    // Assert
    expect(config.deployVia).toBe('pipeline')
    expect(app.node.tryFindChild('prod')).toBeUndefined()

    const pipelineStack = app.node.tryFindChild('PlatformPipeline') as Stack
    expect(pipelineStack).toBeDefined()

    const stage = pipelineStack.node.tryFindChild('prod') as Stage
    expect(stage).toBeDefined()
    const stackIds = stage.node.children.filter(Stack.isStack).map((stack) => stack.node.id)
    expect(stackIds.sort()).toEqual([...EXPECTED_PROD_STACKS].sort())
  })

  test('deployVia=pipeline fails fast on placeholder pipeline context keys', () => {
    // Arrange
    const app = new App({ context: { ...DIRECT_CONTEXT, deployVia: 'pipeline' } })

    // Act + Assert
    expect(() => configurePlatformApp(app)).toThrow('still the placeholder')
  })

  test('rejects an unknown deployVia value', () => {
    // Arrange
    const app = new App({ context: { ...DIRECT_CONTEXT, deployVia: 'staging' } })

    // Act + Assert
    expect(() => configurePlatformApp(app)).toThrow('deployVia')
  })

  test('rejects a pipelineRepo that is not owner/repo', () => {
    // Arrange
    const app = new App({
      context: {
        ...DIRECT_CONTEXT,
        deployVia: 'pipeline',
        pipelineConnectionArn: PIPELINE_CONFIG.pipelineConnectionArn,
        pipelineRepo: 'https://github.com/owner/repo'
      }
    })

    // Act + Assert
    expect(() => configurePlatformApp(app)).toThrow('owner/repo')
  })
})
