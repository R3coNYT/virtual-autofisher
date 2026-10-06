import { describe, expect, it } from 'vitest'
import { canRegen, clampConfigPatch, commandMissing, parseNumberInput } from '../../src/renderer/settingsBounds'

describe('clampConfigPatch', () => {
  it('enforces the minimums', () => {
    expect(clampConfigPatch({ fishing: { baseCooldownSec: 0.5, minGapSec: 1 } })).toEqual({ fishing: { baseCooldownSec: 2, minGapSec: 2 } })
    expect(clampConfigPatch({ sell: { every: 0 } })).toEqual({ sell: { every: 1 } })
    expect(clampConfigPatch({ profile: { refreshMin: 0 } })).toEqual({ profile: { refreshMin: 1 } })
  })
  it('bounds jitter to 0..5', () => {
    expect(clampConfigPatch({ fishing: { jitterSec: -1 } })).toEqual({ fishing: { jitterSec: 0 } })
    expect(clampConfigPatch({ fishing: { jitterSec: 9 } })).toEqual({ fishing: { jitterSec: 5 } })
  })
  it('snaps buff length to 5 or 20', () => {
    expect(clampConfigPatch({ buffs: { lengthMin: 7 as 5 } })).toEqual({ buffs: { lengthMin: 5 } })
    expect(clampConfigPatch({ buffs: { lengthMin: 15 as 5 } })).toEqual({ buffs: { lengthMin: 20 } })
    expect(clampConfigPatch({ buffs: { lengthMin: 20 } })).toEqual({ buffs: { lengthMin: 20 } })
  })
  it('floors breaks and session limit at 0', () => {
    expect(clampConfigPatch({ breaks: { workMin: -3, restJitterMin: -1 }, sessionLimitH: -2 })).toEqual({
      breaks: { workMin: 0, restJitterMin: 0 },
      sessionLimitH: 0
    })
  })
  it('passes valid and unrelated values through, drops NaN', () => {
    expect(clampConfigPatch({ fishing: { baseCooldownSec: 3.5 }, sell: { enabled: false }, capture: true })).toEqual({
      fishing: { baseCooldownSec: 3.5 },
      sell: { enabled: false },
      capture: true
    })
    expect(clampConfigPatch({ fishing: { baseCooldownSec: NaN } })).toEqual({})
  })
  it('keeps bait.amount a non-negative integer', () => {
    expect(clampConfigPatch({ bait: { amount: -4 } })).toEqual({ bait: { amount: 0 } })
    expect(clampConfigPatch({ bait: { amount: 12.6 } })).toEqual({ bait: { amount: 13 } })
  })
  it('does not mutate its input', () => {
    const p = { fishing: { baseCooldownSec: 1 } }
    clampConfigPatch(p)
    expect(p.fishing.baseCooldownSec).toBe(1)
  })
})

describe('parseNumberInput', () => {
  it('accepts comma and dot decimals, rejects blanks and text', () => {
    expect(parseNumberInput('3,5')).toBe(3.5)
    expect(parseNumberInput(' 4.25 ')).toBe(4.25)
    expect(parseNumberInput('')).toBeNull()
    expect(parseNumberInput('abc')).toBeNull()
  })
})

describe('commandMissing', () => {
  it('reports only when the command list is known and lacks the command', () => {
    expect(commandMissing([], 'sell')).toBe(false)
    expect(commandMissing([{ name: 'fish' }], 'sell')).toBe(true)
    expect(commandMissing([{ name: 'sell' }], 'sell')).toBe(false)
  })
})

describe('canRegen', () => {
  const verify = (options: { name: string; type: number; required: boolean; choices?: string[] }[]) => [{ name: 'verify', options }]
  it('is false without /verify or without options', () => {
    expect(canRegen([])).toBe(false)
    expect(canRegen(verify([]))).toBe(false)
  })
  it('is true for a regen choice, false for choices lacking it', () => {
    expect(canRegen(verify([{ name: 'answer', type: 3, required: true, choices: ['regen'] }]))).toBe(true)
    expect(canRegen(verify([{ name: 'answer', type: 3, required: true, choices: ['other'] }]))).toBe(false)
  })
  it('is true for a free string first option', () => {
    expect(canRegen(verify([{ name: 'answer', type: 3, required: true }]))).toBe(true)
    expect(canRegen(verify([{ name: 'answer', type: 4, required: true }]))).toBe(false)
  })
})
