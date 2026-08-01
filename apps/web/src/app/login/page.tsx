'use client'

/**
 * /login — Amplify Authenticator (sign in, sign up, email verification,
 * forgot password) themed to the kaka dark/gold system via the CSS design
 * tokens in amplify-theme.css. A signed-in user is forwarded to /ideas. In
 * local mode (no Cognito env) there is nothing to sign in to, so the page
 * bounces straight to /ideas.
 */

import { Authenticator } from '@aws-amplify/ui-react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { ensureAmplifyConfigured } from '@/lib/auth/amplify'
import { isAuthConfigured } from '@/lib/auth/config'
import '@aws-amplify/ui-react/styles.css'
import './amplify-theme.css'

ensureAmplifyConfigured()

/** Rendered only once the Authenticator has a signed-in user. */
function RedirectToIdeas() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/ideas')
  }, [router])

  return (
    <p className="py-10 text-center font-mono text-xs text-faint">signed in — opening your ideas…</p>
  )
}

/** Local-mode fallback: no Cognito configured, nothing to authenticate. */
function LocalModeRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/ideas')
  }, [router])

  return (
    <div className="flex justify-center py-24">
      <span className="font-mono text-xs text-faint">local mode — no sign-in needed…</span>
    </div>
  )
}

export default function LoginPage() {
  if (!isAuthConfigured()) {
    return <LocalModeRedirect />
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-8 py-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-muted">
          Sign in to your ideas — or create an account and type your first one.
        </p>
      </div>

      <Authenticator
        initialState="signIn"
        loginMechanisms={['email']}
        formFields={{
          signIn: {
            username: { placeholder: 'you@example.com' }
          },
          signUp: {
            email: { placeholder: 'you@example.com', isRequired: true },
            password: { placeholder: 'Create a password' },
            confirm_password: { placeholder: 'Confirm your password' }
          }
        }}
      >
        {() => <RedirectToIdeas />}
      </Authenticator>
    </div>
  )
}
