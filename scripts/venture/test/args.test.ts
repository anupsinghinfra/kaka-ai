import { parseGoldenPathArgs } from '../lib/args'

describe('parseGoldenPathArgs', () => {
  test('defaults to suffix "main" with cleanup enabled', () => {
    // Arrange + Act
    const args = parseGoldenPathArgs([])

    // Assert
    expect(args).toEqual({ suffix: 'main', keep: false })
  })

  test('accepts a custom suffix and the --keep flag in any order', () => {
    // Arrange + Act
    const args = parseGoldenPathArgs(['--keep', 'demo-7'])

    // Assert
    expect(args).toEqual({ suffix: 'demo-7', keep: true })
  })

  test('throws on an unknown flag', () => {
    // Arrange + Act + Assert
    expect(() => parseGoldenPathArgs(['--wipe'])).toThrow('unknown flag: --wipe')
  })

  test('throws on more than one positional argument', () => {
    // Arrange + Act + Assert
    expect(() => parseGoldenPathArgs(['one', 'two'])).toThrow('at most one positional')
  })

  test('throws on a suffix with invalid characters', () => {
    // Arrange + Act + Assert
    expect(() => parseGoldenPathArgs(['Bad_Suffix!'])).toThrow('invalid suffix')
  })
})
