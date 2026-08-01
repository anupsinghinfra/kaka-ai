'use client'

/**
 * Right-hand side of the global header.
 *
 * - Local mode (no Cognito env): the original subtle "local" badge.
 * - Configured, signed out: a quiet "sign in" link.
 * - Configured, signed in: the user's email and a sign-out button
 *   (sign out returns to the public landing page).
 *
 * Auth state is tracked via Amplify's Hub so the header updates after
 * client-side navigation from /login without a remount.
 */

import { fetchUserAttributes, getCurrentUser, signOut } from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ensureAmplifyConfigured } from '@/lib/auth/amplify'
import { isAuthConfigured } from '@/lib/auth/config'

ensureAmplifyConfigured()

type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'signed-in'; readonly email: string }

async function loadSession(): Promise<SessionState> {
  try {
    const user = await getCurrentUser()
    let email: string | undefined
    try {
      const attributes = await fetchUserAttributes()
      email = attributes.email
    } catch {
      // Attributes are cosmetic here; fall back to the username below.
    }
    return { kind: 'signed-in', email: email ?? user.signInDetails?.loginId ?? user.username }
  } catch {
    return { kind: 'signed-out' }
  }
}

export function HeaderAuth() {
  const router = useRouter()
  const [session, setSession] = useState<SessionState>({ kind: 'checking' })
  const configured = isAuthConfigured()

  useEffect(() => {
    if (!configured) {
      return
    }
    let isActive = true
    const refresh = () => {
      void loadSession().then((next) => {
        if (isActive) {
          setSession(next)
        }
      })
    }
    refresh()
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signedOut') {
        refresh()
      }
    })
    return () => {
      isActive = false
      unsubscribe()
    }
  }, [configured])

  if (!configured) {
    return <span className="font-mono text-xs text-faint">local</span>
  }

  if (session.kind === 'checking') {
    return <span className="font-mono text-xs text-faint" aria-hidden="true" />
  }

  if (session.kind === 'signed-out') {
    return (
      <Link href="/login" className="font-mono text-xs text-muted transition-colors hover:text-gold">
        sign in
      </Link>
    )
  }

  async function handleSignOut(): Promise<void> {
    try {
      await signOut()
    } catch {
      // Even if the remote call fails, local tokens are cleared; continue.
    }
    router.push('/')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-3">
      <span className="max-w-[16rem] truncate font-mono text-xs text-muted">{session.email}</span>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        className="font-mono text-xs text-faint transition-colors hover:text-gold"
      >
        Sign out
      </button>
    </div>
  )
}
