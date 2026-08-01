/**
 * Amplify v6 wiring. `ensureAmplifyConfigured` is idempotent and guarded:
 * it is a no-op in local mode (no Cognito env), safe to call from both
 * server and client module scopes (Amplify.configure touches no window
 * APIs), and configures the singleton exactly once per runtime.
 */

import { Amplify } from 'aws-amplify'
import { getAuthConfig } from '@/lib/auth/config'

let hasConfigured = false

/** Configures the Amplify singleton for Cognito auth when env is present. */
export function ensureAmplifyConfigured(): void {
  if (hasConfigured) {
    return
  }
  const config = getAuthConfig()
  if (config === undefined) {
    return
  }
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: { email: true },
        signUpVerificationMethod: 'code'
      }
    }
  })
  hasConfigured = true
}
