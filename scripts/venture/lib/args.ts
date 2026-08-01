/**
 * CLI argument parsing for golden-path.ts.
 *
 * Usage: golden-path [suffix] [--keep]
 *   suffix  customer-id suffix (default "main") → cells gp-{suffix} and
 *           gp-{suffix}-branch
 *   --keep  skip cleanup (leave both cells running)
 */

const SUFFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const DEFAULT_SUFFIX = 'main'

/** Parsed golden-path CLI arguments. */
export interface GoldenPathArgs {
  readonly suffix: string
  readonly keep: boolean
}

/** Parses argv (already sliced past node and the script path). */
export function parseGoldenPathArgs(argv: readonly string[]): GoldenPathArgs {
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const positionals = argv.filter((arg) => !arg.startsWith('--'))

  for (const flag of flags) {
    if (flag !== '--keep') {
      throw new Error(`unknown flag: ${flag} (supported: --keep)`)
    }
  }
  if (positionals.length > 1) {
    throw new Error(`expected at most one positional argument (suffix), got: ${positionals.join(' ')}`)
  }

  const suffix = positionals[0] ?? DEFAULT_SUFFIX
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`invalid suffix "${suffix}": must match ${SUFFIX_PATTERN}`)
  }

  return { suffix, keep: flags.includes('--keep') }
}
