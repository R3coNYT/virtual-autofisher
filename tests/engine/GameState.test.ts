import { describe, it, expect, vi } from 'vitest'
import { GameState } from '../../src/main/engine/GameState'
import type { GameEvent } from '../../src/shared/types'

const inv = (bait = 100): GameEvent => ({
  kind: 'inventory',
  balance: 500,
  level: 10,
  xpToNext: 40,
  rod: 'Rod',
  biome: 'River',
  bait: { name: 'Common', count: bait },
  rare: { gold: 1, emerald: 0, lava: 0, diamond: 0 }
})
const fish = (items: { name: string; count: number }[], extra = {}): GameEvent => ({
  kind: 'catch',
  items,
  raw: '',
  ...extra
})

describe('GameState', () => {
  it('catch adds species, counters and a log line', () => {
    const g = new GameState(() => 1000)
    g.apply(fish([{ name: 'Cod', count: 2 }, { name: 'Salmon', count: 1 }], { xp: 5 }))
    const s = g.snapshot()
    expect(s.session.fishBySpecies).toEqual({ Cod: 2, Salmon: 1 })
    expect(s.session.catches).toBe(3)
    expect(s.session.xpEarned).toBe(5)
    expect(g.catchesSinceSell).toBe(3)
    expect(s.log[0]).toMatchObject({ type: 'catch', text: 'Pêché : 2× Cod, 1× Salmon' })
  })
  it('counts rare fish', () => {
    const g = new GameState()
    g.apply(fish([{ name: 'Gold Fish', count: 1 }, { name: 'Lava Eel', count: 2 }]))
    expect(g.snapshot().session.rareCaught).toMatchObject({ gold: 1, lava: 2, emerald: 0 })
  })
  it('sell adds money and resets catchesSinceSell', () => {
    const g = new GameState()
    g.apply(fish([{ name: 'Cod', count: 2 }]))
    g.apply({ kind: 'sell', earned: 1234 })
    expect(g.snapshot().session.moneyEarned).toBe(1234)
    expect(g.snapshot().session.sells).toBe(1)
    expect(g.catchesSinceSell).toBe(0)
    expect(g.snapshot().log.at(-1)!.text).toBe('Vendu pour 1 234 $')
  })
  it('inventory updates account and recalibrates bait; catch decrements it', () => {
    const g = new GameState()
    expect(g.baitEstimate).toBeNull()
    g.apply(inv(100))
    expect(g.snapshot().account).toMatchObject({ balance: 500, level: 10, rod: 'Rod' })
    expect(g.baitEstimate).toBe(100)
    g.apply(fish([{ name: 'Cod', count: 1 }]))
    expect(g.baitEstimate).toBe(99)
    g.apply(inv(50))
    expect(g.baitEstimate).toBe(50)
  })
  it('caps the log at 500 with increasing ids', () => {
    const g = new GameState()
    for (let i = 0; i < 520; i++) g.apply({ kind: 'error', text: `e${i}` })
    const log = g.snapshot().log
    expect(log).toHaveLength(500)
    expect(log[0].id).toBe(21)
    expect(log.at(-1)!.id).toBe(520)
  })
  it('levelUp yields a highlighted entry', () => {
    const g = new GameState()
    g.apply(fish([{ name: 'Cod', count: 1 }], { levelUp: 12 }))
    const s = g.snapshot()
    expect(s.account.level).toBe(12)
    expect(s.log.find((l) => l.highlight)!.text).toBe('Niveau 12 atteint !')
  })
  it('onPatch receives only changed fields and new log entries', () => {
    const g = new GameState()
    const cb = vi.fn()
    g.onPatch(cb)
    g.apply(fish([{ name: 'Cod', count: 3 }]))
    const [patch, newLog] = cb.mock.calls[0]
    expect(patch).toEqual({ session: { catches: 3, fishBySpecies: { Cod: 3 } } })
    expect(newLog).toHaveLength(1)
    g.apply({ kind: 'cooldown', waitMs: 100 })
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('unsubscribe stops patches; setNextFishAt emits', () => {
    const g = new GameState()
    const cb = vi.fn()
    const off = g.onPatch(cb)
    g.setNextFishAt(42)
    expect(cb.mock.calls[0][0]).toEqual({ nextFishAt: 42 })
    off()
    g.setNextFishAt(null)
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('captcha, daily, commands', () => {
    const g = new GameState(() => 1000)
    g.apply({ kind: 'captcha', text: 'x' })
    g.markCaptcha()
    g.markCommandSent('fish')
    g.apply({ kind: 'daily', reward: '100$' })
    const s = g.snapshot()
    expect(s.session.captchas).toBe(2)
    expect(s.session.commandsSent).toBe(1)
    expect(s.nextDailyAt).toBe(1000 + 86400000)
  })
  it('session start/end', () => {
    let t = 10
    const g = new GameState(() => t)
    g.startSession()
    g.apply(fish([{ name: 'Cod', count: 1 }]))
    t = 99
    const sum = g.endSession()
    expect(sum).toMatchObject({ startedAt: 10, endedAt: 99, catches: 1 })
    expect(g.snapshot().session.catches).toBe(0)
  })
  it('startSession resets catchesSinceSell', () => {
    const g = new GameState()
    g.apply(fish([{ name: 'Cod', count: 4 }]))
    expect(g.catchesSinceSell).toBe(4)
    g.startSession()
    expect(g.catchesSinceSell).toBe(0)
  })
  it('daily sets nextDailyAt = now + 24h and logs', () => {
    const g = new GameState(() => 5000)
    g.apply({ kind: 'daily', reward: '100 $' })
    const s = g.snapshot()
    expect(s.nextDailyAt).toBe(5000 + 24 * 3600 * 1000)
    expect(s.log[0]).toMatchObject({ type: 'trade', text: 'Récompense quotidienne : 100 $' })
  })

  const cases: { name: string; ev: GameEvent; check: (s: ReturnType<GameState['snapshot']>) => void; log?: [string, string] }[] = [
    {
      name: 'stats merges totals and extras',
      ev: { kind: 'stats', crates: 3, quests: 4, trips: 5, dailyStreak: 6, totals: { gold: 2, lava: 1 } },
      check: (s) =>
        expect(s.account.totals).toEqual({ gold: 2, lava: 1, crates: 3, quests: 4, trips: 5, dailyStreak: 6 })
    },
    {
      name: 'stats without extras keeps only totals',
      ev: { kind: 'stats', totals: { diamond: 1 } },
      check: (s) => expect(s.account.totals).toEqual({ diamond: 1 })
    },
    {
      name: 'boosts replace',
      ev: { kind: 'boosts', active: [{ name: 'Luck', endsAt: 99 }] },
      check: (s) => expect(s.boosts).toEqual([{ name: 'Luck', endsAt: 99 }])
    },
    {
      name: 'quests replace',
      ev: { kind: 'quests', quests: [{ label: 'Catch 10', progress: '3/10', done: false }] },
      check: (s) => expect(s.quests).toEqual([{ label: 'Catch 10', progress: '3/10', done: false }])
    },
    {
      name: 'purchase with cost',
      ev: { kind: 'purchase', item: 'Bait', amount: 5, cost: 1500 },
      check: () => {},
      log: ['trade', 'Acheté : 5× Bait (1 500 $)']
    },
    {
      name: 'purchase without cost',
      ev: { kind: 'purchase', item: 'Bait', amount: 2 },
      check: () => {},
      log: ['trade', 'Acheté : 2× Bait']
    },
    {
      name: 'captchaSolved',
      ev: { kind: 'captchaSolved' },
      check: () => {},
      log: ['system', 'Captcha résolu']
    },
    {
      name: 'captchaFailed',
      ev: { kind: 'captchaFailed', text: 'wrong' },
      check: () => {},
      log: ['system', 'Captcha échoué : wrong']
    },
    { name: 'error', ev: { kind: 'error', text: 'boom' }, check: () => {}, log: ['error', 'boom'] },
    {
      name: 'unknown with title',
      ev: { kind: 'unknown', title: 'Hi', text: 'there' },
      check: () => {},
      log: ['unknown', 'Hi — there']
    },
    { name: 'unknown without title', ev: { kind: 'unknown', text: 'there' }, check: () => {}, log: ['unknown', 'there'] }
  ]
  it.each(cases)('applies $name', ({ ev, check, log }) => {
    const g = new GameState()
    g.apply(ev)
    const s = g.snapshot()
    check(s)
    if (log) {
      expect(s.log).toHaveLength(1)
      expect(s.log[0]).toMatchObject({ type: log[0], text: log[1] })
    } else expect(s.log).toHaveLength(0)
  })
})
