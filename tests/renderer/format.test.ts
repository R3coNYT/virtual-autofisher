import { describe, expect, it } from 'vitest'
import {
  catchesPerHour,
  formatCompact,
  formatDuration,
  formatMoney,
  logFilter,
  coinflipOptionNames,
  parseCommandLine,
  xpProgress
} from '../../src/renderer/format'
import type { LogEntry, SlashCommandInfo } from '../../src/shared/types'

const norm = (s: string): string => s.replace(/[\u202f\u00a0]/g, ' ')

describe('formatMoney', () => {
  it('groups thousands with spaces and appends $', () => {
    expect(norm(formatMoney(1234567))).toBe('1 234 567 $')
    expect(norm(formatMoney(0))).toBe('0 $')
    expect(norm(formatMoney(-1500))).toMatch(/^[-\u2212]1 500 \$$/)
  })
  it('rounds and tolerates null', () => {
    expect(norm(formatMoney(12.6))).toBe('13 $')
    expect(formatMoney(null)).toBe('—')
  })
})

describe('formatCompact', () => {
  it('abbreviates large numbers with a decimal comma', () => {
    expect(norm(formatCompact(1_200_000))).toBe('1,2 M')
    expect(norm(formatCompact(3_000_000))).toBe('3 M')
    expect(norm(formatCompact(45_300))).toBe('45,3 k')
    expect(norm(formatCompact(2_500_000_000))).toBe('2,5 Md')
  })
  it('leaves small numbers alone', () => {
    expect(formatCompact(999)).toBe('999')
  })
})

describe('formatDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(3_720_000)).toBe('1 h 02 min')
    expect(formatDuration(245_000)).toBe('4 min 05 s')
    expect(formatDuration(12_000)).toBe('12 s')
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(-5000)).toBe('0 s')
  })
})

describe('catchesPerHour', () => {
  it('computes the hourly rate', () => {
    expect(catchesPerHour(50, 0, 3_600_000)).toBe(50)
    expect(catchesPerHour(10, 0, 1_800_000)).toBe(20)
  })
  it('returns null when it cannot be computed', () => {
    expect(catchesPerHour(5, null, 1000)).toBeNull()
    expect(catchesPerHour(5, 1000, 1000)).toBeNull()
  })
})

describe('xpProgress', () => {
  it('returns null when unknown', () => {
    expect(xpProgress(null, 100)).toBeNull()
    expect(xpProgress(5, null)).toBeNull()
  })
  it('stays within 0..1', () => {
    for (const [l, x] of [[1, 0], [12, 3450], [30, 99_999_999]] as const) {
      const p = xpProgress(l, x)
      expect(p).not.toBeNull()
      expect(p!).toBeGreaterThanOrEqual(0)
      expect(p!).toBeLessThanOrEqual(1)
    }
    expect(xpProgress(10, 0)).toBe(1)
  })
})

describe('logFilter', () => {
  const e = (type: LogEntry['type']): LogEntry => ({ id: 1, at: 0, type, text: '' })
  it('filters by category', () => {
    expect(logFilter(e('catch'), 'all')).toBe(true)
    expect(logFilter(e('catch'), 'catch')).toBe(true)
    expect(logFilter(e('trade'), 'catch')).toBe(false)
    expect(logFilter(e('trade'), 'trade')).toBe(true)
    for (const t of ['system', 'error', 'unknown'] as const) {
      expect(logFilter(e(t), 'system')).toBe(true)
      expect(logFilter(e(t), 'trade')).toBe(false)
    }
    expect(logFilter(e('catch'), 'system')).toBe(false)
  })
})

describe('parseCommandLine', () => {
  const cmds: SlashCommandInfo[] = [
    {
      name: 'coinflip',
      id: '1',
      version: '1',
      options: [
        { name: 'side', type: 3, required: true, choices: ['heads', 'tails'] },
        { name: 'amount', type: 4, required: true }
      ]
    },
    { name: 'top', id: '2', version: '1', options: [] }
  ]
  it('parses name and options, coercing numeric types', () => {
    expect(parseCommandLine('/coinflip side=heads amount=100', cmds)).toEqual({
      ok: true,
      name: 'coinflip',
      options: { side: 'heads', amount: 100 }
    })
    expect(parseCommandLine('top', cmds)).toEqual({ ok: true, name: 'top', options: {} })
  })
  it('supports quoted values', () => {
    const c: SlashCommandInfo[] = [{ name: 'say', id: '3', version: '1', options: [{ name: 'text', type: 3, required: false }] }]
    expect(parseCommandLine('/say text="a b"', c)).toEqual({ ok: true, name: 'say', options: { text: 'a b' } })
  })
  it('rejects unknown commands and options', () => {
    const a = parseCommandLine('/nope', cmds)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toMatch(/nope/)
    const b = parseCommandLine('/coinflip foo=1 side=heads amount=2', cmds)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toMatch(/foo/)
  })
  it('rejects bad numbers, missing required options and empty input', () => {
    expect(parseCommandLine('/coinflip side=heads amount=abc', cmds).ok).toBe(false)
    expect(parseCommandLine('/coinflip side=heads', cmds).ok).toBe(false)
    expect(parseCommandLine('/coinflip heads', cmds).ok).toBe(false)
    expect(parseCommandLine('  ', cmds).ok).toBe(false)
  })
})

describe('coinflipOptionNames', () => {
  it('matches by name, then falls back to position', () => {
    const named: SlashCommandInfo = {
      name: 'coinflip', id: '1', version: '1',
      options: [{ name: 'montant', type: 4, required: true }, { name: 'face', type: 3, required: true, choices: ['pile', 'face'] }]
    }
    expect(coinflipOptionNames(named)).toEqual({ side: 'face', amount: 'montant', choices: ['pile', 'face'] })
    const pos: SlashCommandInfo = {
      name: 'coinflip', id: '1', version: '1',
      options: [{ name: 'a', type: 3, required: true }, { name: 'b', type: 4, required: true }]
    }
    expect(coinflipOptionNames(pos)).toMatchObject({ side: 'a', amount: 'b' })
    expect(coinflipOptionNames(undefined)).toMatchObject({ side: 'side', amount: 'amount' })
  })
})
