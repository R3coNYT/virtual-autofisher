import { describe, expect, it } from 'vitest'
import { applyGamePatch, emptySnapshot } from '../../src/renderer/applyGamePatch'

describe('applyGamePatch', () => {
  it('replaces fishBySpecies wholesale, dropping stale keys', () => {
    const prev = emptySnapshot()
    prev.session.fishBySpecies = { carp: 3, eel: 1 }
    const next = applyGamePatch(prev, { session: { fishBySpecies: { carp: 4 } } })
    expect(next.session.fishBySpecies).toEqual({ carp: 4 })
  })

  it('keeps other session fields when only catches is patched', () => {
    const prev = emptySnapshot()
    prev.session.moneyEarned = 120
    prev.session.fishBySpecies = { carp: 3 }
    const next = applyGamePatch(prev, { session: { catches: 7 } })
    expect(next.session.catches).toBe(7)
    expect(next.session.moneyEarned).toBe(120)
    expect(next.session.fishBySpecies).toEqual({ carp: 3 })
  })

  it('replaces the boosts array', () => {
    const prev = emptySnapshot()
    prev.boosts = [{ name: 'a', endsAt: 1 }, { name: 'b', endsAt: 2 }]
    const next = applyGamePatch(prev, { boosts: [{ name: 'c', endsAt: 3 }] })
    expect(next.boosts).toEqual([{ name: 'c', endsAt: 3 }])
  })

  it('replaces account.totals and keeps other account fields', () => {
    const prev = emptySnapshot()
    prev.account.balance = 50
    prev.account.totals = { crates: 2, trips: 9 }
    const next = applyGamePatch(prev, { account: { totals: { crates: 3 } } })
    expect(next.account.totals).toEqual({ crates: 3 })
    expect(next.account.balance).toBe(50)
  })

  it('sets scalar sections and does not mutate prev', () => {
    const prev = emptySnapshot()
    const next = applyGamePatch(prev, { nextFishAt: 123 })
    expect(next.nextFishAt).toBe(123)
    expect(prev.nextFishAt).toBeNull()
    expect(next.session).toBe(prev.session)
  })
})
