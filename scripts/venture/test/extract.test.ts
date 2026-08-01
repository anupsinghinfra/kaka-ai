import { extractFileContent, extractKvValue, isRecord } from '../lib/extract'

describe('extractFileContent', () => {
  test('returns a bare string result as-is', () => {
    expect(extractFileContent('file body')).toBe('file body')
  })

  test('reads the content field from an object result', () => {
    expect(extractFileContent({ content: 'file body' })).toBe('file body')
  })

  test('reads content nested under a result envelope', () => {
    expect(extractFileContent({ result: { content: 'file body' } })).toBe('file body')
  })

  test('returns undefined when no content is present', () => {
    expect(extractFileContent({ size: 12 })).toBeUndefined()
    expect(extractFileContent(undefined)).toBeUndefined()
  })
})

describe('extractKvValue', () => {
  test('reads the value field from an object result', () => {
    expect(extractKvValue({ value: '1' })).toBe('1')
  })

  test('reads value nested under a result envelope', () => {
    expect(extractKvValue({ result: { value: 7 } })).toBe(7)
  })

  test('falls back to the raw result when no value field exists', () => {
    expect(extractKvValue('raw')).toBe('raw')
  })
})

describe('isRecord', () => {
  test('accepts plain objects and rejects arrays, null, and primitives', () => {
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([1])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})
