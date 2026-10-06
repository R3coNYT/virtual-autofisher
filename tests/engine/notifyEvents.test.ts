import { describe, expect, it } from 'vitest'
import { levelUpFromLog, rareIncreases } from '../../src/main/notifyEvents'

const entry = (text: string, highlight?: boolean) => ({ id: 1, at: 0, type: 'system' as const, text, highlight })

describe('levelUpFromLog', () => {
  it('reads the level from a highlighted level-up entry', () => {
    expect(levelUpFromLog([entry('Pêché : 1× Cod'), entry('Niveau 42 atteint !', true)])).toBe(42)
  })
  it('ignores non highlighted or unrelated entries', () => {
    expect(levelUpFromLog([entry('Niveau 42 atteint !'), entry('Captcha détecté', true)])).toBeNull()
  })
})

describe('rareIncreases', () => {
  const zero = { gold: 0, emerald: 0, lava: 0, diamond: 0 }
  it('lists only species that increased', () => {
    expect(rareIncreases(zero, { gold: 1, diamond: 2 })).toEqual(['or', 'diamant'])
  })
  it('is empty when unchanged or reset', () => {
    expect(rareIncreases({ ...zero, gold: 3 }, { gold: 3 })).toEqual([])
    expect(rareIncreases({ ...zero, gold: 3 }, { gold: 0 })).toEqual([])
  })
})
