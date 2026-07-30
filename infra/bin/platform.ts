#!/usr/bin/env node
import { App, Aspects } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import { loadPlatformConfig } from '../lib/platform-config'
import { ProdStage } from '../lib/prod-stage'

const app = new App()
const config = loadPlatformConfig(app)

new ProdStage(app, 'prod', {
  config,
  env: {
    account: config.prodAccount,
    region: config.prodRegion
  }
})

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
