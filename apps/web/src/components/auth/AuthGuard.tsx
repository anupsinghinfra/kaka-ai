'use client'

/**
 * Client-side auth gate for the /ideas subtree.
 *
 * - Local mode (no Cognito env): renders children untouched — no gating.
 * - Configured: requires a signed-in Cognito session; otherwise redirects
 *   to /login. Also reacts to sign-out events while mounted.
 *
 * Scope note (deliberate, local MVP): only the UI is gated. The /api/ideas*
 * route handlers stay unauthenticated local-mode endpoints — this app runs
 * on a single-user machine; server-side enforcement comes with the hosted
 * deployment.
 */

import { getCurrentUser } from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { ensureAmplifyConfigured } from '@/lib/auth/amplify'
import { isAuthConfigured } from '@/lib/auth/config'

ensureAmplifyConfigured()

interface AuthGuardProps {
  children: ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter()
  const configured = isAuthConfigured()
  const [isAuthed, setIsAuthed] = useState(!configured)

  useEffect(() => {
    if (!configured) {
      return
    }
    let isActive = true
    getCurrentUser()
      .then(() => {
        if (isActive) {
          setIsAuthed(true)
        }
      })
      .catch(() => {
        if (isActive) {
          router.replace('/login')
        }
      })
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedOut' && isActive) {
        router.replace('/login')
      }
    })
    return () => {
      isActive = false
      unsubscribe()
    }
  }, [configured, router])

  if (!isAuthed) {
    return (
      <div className="flex justify-center py-24">
        <span className="font-mono text-xs text-faint">checking session…</span>
      </div>
    )
  }

  return <>{children}</>
}
