'use client'

import { useState, type ReactNode } from 'react'

interface UnderTheHoodProps {
  children: ReactNode
}

/** Collapsed home for the operational panels (console, files, journal…). */
export function UnderTheHood({ children }: UnderTheHoodProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <section className="border-t border-edge pt-4">
      <button
        type="button"
        className="flex items-center gap-2 text-left"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="font-mono text-xs text-faint">{isOpen ? '▾' : '▸'}</span>
        <span className="section-title">Under the hood</span>
        <span className="text-xs text-faint">console, files, journal, snapshots</span>
      </button>
      {isOpen && <div className="mt-4 flex flex-col gap-6">{children}</div>}
    </section>
  )
}
