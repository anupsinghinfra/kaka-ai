import type { Config } from 'tailwindcss'

/**
 * kaka design tokens — dark, minimal, confident. Near-black background,
 * warm off-white text, a single gold accent.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0a09',
        panel: '#131210',
        raised: '#1a1815',
        edge: '#26231e',
        fg: '#f0eadd',
        muted: '#8f887a',
        faint: '#5c574d',
        gold: '#d4a54a',
        good: '#5fbf77',
        bad: '#d96a6a'
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
}

export default config
