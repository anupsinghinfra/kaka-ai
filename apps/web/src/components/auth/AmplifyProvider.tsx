'use client'

/**
 * Mounted once in the root layout so Amplify is configured in the client
 * bundle before any auth-aware component renders. Configuration happens at
 * module scope (the Amplify singleton must be set up before children's
 * effects run) and is guarded — a no-op in local mode and SSR-safe.
 */

import type { ReactNode } from 'react'
import { ensureAmplifyConfigured } from '@/lib/auth/amplify'

ensureAmplifyConfigured()

interface AmplifyProviderProps {
  children: ReactNode
}

export function AmplifyProvider({ children }: AmplifyProviderProps) {
  return <>{children}</>
}
