import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

/**
 * IdeaWorkspace initial render — the live-URL payoff states. Rendered with
 * react-dom/server (hooks resolve to their initial state); next/navigation
 * is stubbed so no app router is needed.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined })
}))

import { IdeaWorkspace, type IterationView } from '@/components/IdeaWorkspace'

const V1: IterationView = {
  v: 1,
  summary: 'Built the anvil shop.',
  at: '2026-08-01T01:00:00.000Z',
  checkPassed: true
}

function render(props: Partial<Parameters<typeof IdeaWorkspace>[0]> = {}): string {
  return renderToStaticMarkup(
    <IdeaWorkspace
      name="acme"
      idea="sell anvils online"
      builderReady={true}
      iterations={[]}
      {...props}
    />
  )
}

describe('IdeaWorkspace live URL states', () => {
  test('shows the unmissable Open your product button and URL when live', () => {
    // Act
    const html = render({ iterations: [V1], liveUrl: 'https://dev--v-acme.cells.oncell.ai' })

    // Assert
    expect(html).toContain('Open your product ↗')
    expect(html).toContain('https://dev--v-acme.cells.oncell.ai')
    expect(html).toContain('target="_blank"')
  })

  test('shows the subtle URL placeholder before the first build', () => {
    // Act
    const html = render()

    // Assert
    expect(html).toContain('URL appears here when v1 ships')
    expect(html).not.toContain('Open your product')
  })

  test('offers Start app with the error note when the service failed', () => {
    // Act
    const html = render({ iterations: [V1], serviceError: 'the app crashed on boot' })

    // Assert
    expect(html).toContain('the app crashed on boot')
    expect(html).toContain('Start app')
    expect(html).not.toContain('Open your product')
  })

  test('offers Start app when built but not currently running', () => {
    // Act
    const html = render({ iterations: [V1] })

    // Assert
    expect(html).toContain('running right now')
    expect(html).toContain('Start app')
  })

  test('renders the timeline with the check badge and version summary', () => {
    // Act
    const html = render({ iterations: [V1] })

    // Assert
    expect(html).toContain('check ✓')
    expect(html).toContain('Built: Built the anvil shop.')
  })
})

describe('IdeaWorkspace durable auto-improve state', () => {
  test('shows the server-side auto state with the next wake countdown', () => {
    // Arrange — a wake ~30 minutes out.
    const nextWakeAt = new Date(Date.now() + 30 * 60_000).toISOString()

    // Act
    const html = render({ iterations: [V1], autoImprove: true, nextWakeAt })

    // Assert
    expect(html).toContain('improving on its own')
    expect(html).toMatch(/next wake ~(29|30)m/)
    expect(html).toContain('auto-improving')
  })

  test('shows auto-improve off by default', () => {
    // Act
    const html = render({ iterations: [V1] })

    // Assert
    expect(html).toContain('Auto-improve')
    expect(html).not.toContain('improving on its own')
  })
})
