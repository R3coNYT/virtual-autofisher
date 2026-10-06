import { describe, expect, it } from 'vitest'
import { levelUpFromLog, rareIncreases } from '../../src/main/notifyEvents'

const entry = (text: string, highlight?: boolean, levelUp?: number) => ({ id: 1, at: 0, type: 'system' as const, text, highlight, levelUp })

describe('levelUpFromLog', () => {
  it('reads the level from the structured levelUp field', () => {
    expect(levelUpFromLog([entry('Caught: 1× Cod'), entry('Reached level 42!', true, 42)])).toBe(42)
  })
  it('ignores entries without levelUp, whatever their text', () => {
    expect(levelUpFromLog([entry('Reached level 42!', true), entry('Captcha detected', true)])).toBeNull()
  })
})

describe('rareIncreases', () => {
  const zero = { gold: 0, emerald: 0, lava: 0, diamond: 0 }
  it('lists only species that increased', () => {
    expect(rareIncreases(zero, { gold: 1, diamond: 2 })).toEqual(['Gold Fish', 'Diamond Fish'])
  })
  it('is empty when unchanged or reset', () => {
    expect(rareIncreases({ ...zero, gold: 3 }, { gold: 3 })).toEqual([])
    expect(rareIncreases({ ...zero, gold: 3 }, { gold: 0 })).toEqual([])
  })
})
