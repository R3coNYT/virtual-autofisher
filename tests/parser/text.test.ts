import { describe, expect, it } from 'vitest'
import { cleanText, parseDuration, parseNumber } from '../../src/main/parser/text'

describe('parseNumber', () => {
  it('parses plain, comma and currency numbers', () => {
    expect(parseNumber('1,234,567')).toBe(1234567)
    expect(parseNumber('$1,234')).toBe(1234)
  })
  it('parses k/M suffixes', () => {
    expect(parseNumber('1.2M')).toBe(1200000)
    expect(parseNumber('12.5k')).toBe(12500)
  })
  it('returns null when there is no number', () => {
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
  it('does not read a unit word as a suffix', () => {
    expect(parseNumber('5 minutes')).toBe(5)
  })
})

describe('parseDuration', () => {
  it('parses combined units', () => {
    expect(parseDuration('5m 30s')).toBe(330000)
    expect(parseDuration('1h 2m')).toBe(3720000)
  })
  it('parses words and decimals', () => {
    expect(parseDuration('12 seconds')).toBe(12000)
    expect(parseDuration('2.4 seconds')).toBe(2400)
  })
  it('returns null without a duration', () => {
    expect(parseDuration('soon')).toBeNull()
  })
})

describe('cleanText', () => {
  it('strips custom emoji and markdown', () => {
    expect(cleanText('<:fish:123> **Cod** x2')).toBe('Cod x2')
    expect(cleanText('<a:spin:456> _x_ ~~y~~ `z`')).toBe('x y z')
  })
  it('strips :shortcodes: and compacts spaces', () => {
    expect(cleanText(':fish:   Cod    x2')).toBe('Cod x2')
  })
})
