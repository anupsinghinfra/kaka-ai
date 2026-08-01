'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { apiFetch, describeError } from './client-api'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function CreateVentureForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [idea, setIdea] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const trimmedName = name.trim()
  const isNameValid =
    trimmedName.length >= 1 && trimmedName.length <= 40 && NAME_RE.test(trimmedName)
  const canSubmit = isNameValid && !isSubmitting

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) {
      return
    }
    setIsSubmitting(true)
    setError(undefined)
    try {
      await apiFetch('/api/ventures', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          ...(idea.trim().length > 0 ? { idea: idea.trim() } : {})
        })
      })
      router.push(`/ventures/${encodeURIComponent(trimmedName)}`)
      router.refresh()
    } catch (submitError: unknown) {
      setError(describeError(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel p-5">
      <h2 className="section-title mb-4">New venture</h2>
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="venture-name" className="mb-1 block text-xs text-muted">
            Name <span className="text-faint">(kebab-case, 1–40 chars)</span>
          </label>
          <input
            id="venture-name"
            className="field font-mono"
            placeholder="lemonade-stand"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
          />
          {name.length > 0 && !isNameValid && (
            <p className="mt-1 text-xs text-bad">
              Use lowercase letters, digits, and single hyphens.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="venture-idea" className="mb-1 block text-xs text-muted">
            Idea <span className="text-faint">(what should this venture become?)</span>
          </label>
          <textarea
            id="venture-idea"
            className="field min-h-[88px] resize-y"
            placeholder="A tip calculator that splits bills fairly, including awkward group dinners."
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            maxLength={2000}
          />
        </div>
        {error !== undefined && <p className="text-sm text-bad">{error}</p>}
        <div>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {isSubmitting ? 'Creating cell…' : 'Create venture'}
          </button>
        </div>
      </div>
    </form>
  )
}
