'use client'

/**
 * The front door: type a startup idea, get a workspace. The idea comes
 * first; a URL-friendly handle is suggested from it and stays editable.
 */

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { apiFetch, describeError } from './client-api'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NAME_MAX_LENGTH = 40
const SLUG_WORD_COUNT = 4

/** Suggests a kebab-case handle from the first few words of the idea. */
export function slugFromIdea(idea: string): string {
  return idea
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, SLUG_WORD_COUNT)
    .join('-')
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/, '')
}

export function NewIdeaForm() {
  const router = useRouter()
  const [idea, setIdea] = useState('')
  const [name, setName] = useState('')
  const [hasEditedName, setHasEditedName] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const trimmedName = name.trim()
  const isNameValid =
    trimmedName.length >= 1 && trimmedName.length <= NAME_MAX_LENGTH && NAME_RE.test(trimmedName)
  const canSubmit = isNameValid && idea.trim().length > 0 && !isSubmitting

  function handleIdeaChange(value: string): void {
    setIdea(value)
    if (!hasEditedName) {
      setName(slugFromIdea(value))
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) {
      return
    }
    setIsSubmitting(true)
    setError(undefined)
    try {
      await apiFetch('/api/ideas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, idea: idea.trim() })
      })
      router.push(`/ideas/${encodeURIComponent(trimmedName)}`)
      router.refresh()
    } catch (submitError: unknown) {
      setError(describeError(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel p-5">
      <h2 className="section-title mb-4">New idea</h2>
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="idea-text" className="mb-1 block text-xs text-muted">
            Your startup idea <span className="text-faint">(one honest sentence is enough)</span>
          </label>
          <textarea
            id="idea-text"
            className="field min-h-[88px] resize-y"
            placeholder="A tip calculator that splits bills fairly, including awkward group dinners."
            value={idea}
            onChange={(event) => handleIdeaChange(event.target.value)}
            maxLength={2000}
          />
        </div>
        <div>
          <label htmlFor="idea-name" className="mb-1 block text-xs text-muted">
            Handle <span className="text-faint">(its name around here — edit if you like)</span>
          </label>
          <input
            id="idea-name"
            className="field font-mono"
            placeholder="tip-calculator"
            value={name}
            onChange={(event) => {
              setHasEditedName(true)
              setName(event.target.value)
            }}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
          {name.length > 0 && !isNameValid && (
            <p className="mt-1 text-xs text-bad">
              Use lowercase letters, digits, and single hyphens.
            </p>
          )}
        </div>
        {error !== undefined && <p className="text-sm text-bad">{error}</p>}
        <div>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {isSubmitting ? 'Opening your workspace…' : 'Start building'}
          </button>
        </div>
      </div>
    </form>
  )
}
