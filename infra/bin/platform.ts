#!/usr/bin/env node
import { App } from 'aws-cdk-lib'
import { configurePlatformApp } from '../lib/platform-app'

const app = new App()
configurePlatformApp(app)
