/**
 * /ideas subtree layout — wraps the dashboard and idea pages in the client
 * auth gate. In local mode (no Cognito env) the gate is a pass-through.
 */

import type { ReactNode } from 'react'
import { AuthGuard } from '@/components/auth/AuthGuard'

interface IdeasLayoutProps {
  children: ReactNode
}

export default function IdeasLayout({ children }: IdeasLayoutProps) {
  return <AuthGuard>{children}</AuthGuard>
}
