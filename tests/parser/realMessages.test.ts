import { describe, expect, it } from 'vitest'
import { parseMessage } from '../../src/main/parser'
import { loadReal } from '../helpers/realFixture'

const NOW = 1_700_000_000_000
const parse = (name: string) => parseMessage(loadReal(name), NOW)

describe('real Virtual Fisher captures (Components V2)', () => {
  it('toBotMessage: catch heading → title, rest → description', () => {
    const bm = loadReal('catch-plain')
    expect(bm.embeds[0].title).toBe('Player One')
    expect(bm.embeds[0].description).toMatch(/^### You caught:\n20 <:turtle:\d+> Turtle/)
  })

  it('plain catch: items, +N XP', () => {
    expect(parse('catch-plain')).toMatchObject({
      kind: 'catch',
      items: [
        { name: 'Turtle', count: 20 },
        { name: 'Dolphin', count: 3 }
      ],
      xp: 20821,
      levelUp: undefined,
      treasure: undefined
    })
  })

  it('catch + chest giving XP: chest is treasure, xp is the "+N XP" line', () => {
    const e = parse('catch-chest-xp')
    expect(e).toMatchObject({ kind: 'catch', items: [{ name: 'Turtle', count: 15 }], xp: 30137 })
    if (e.kind !== 'catch') return
    expect(e.treasure).toEqual([expect.stringMatching(/^You found a rare chest/)])
    expect(e.questsCompleted).toBeUndefined()
  })

  it('catch + chest with rare fish: "You got 5 Lava Fish from the chest!" is an item', () => {
    const e = parse('catch-chest-lava')
    expect(e).toMatchObject({
      kind: 'catch',
      items: [
        { name: 'Squid', count: 2 },
        { name: 'Turtle', count: 22 },
        { name: 'Dolphin', count: 1 },
        { name: 'Lava Fish', count: 5 }
      ],
      xp: 19921
    })
    if (e.kind === 'catch') expect(e.treasure).toHaveLength(1)
  })

  it('catch + LEVEL UP + QUEST COMPLETE: level, quest name, gold fish; rewards are not items', () => {
    const e = parse('catch-levelup-quest')
    expect(e.kind).toBe('catch')
    if (e.kind !== 'catch') return
    expect(e.items).toEqual([
      { name: 'Turtle', count: 14 },
      { name: 'Dolphin', count: 1 },
      { name: 'Gold Fish', count: 6 }
    ])
    expect(e.xp).toBe(23962)
    expect(e.levelUp).toBe(155)
    expect(e.questsCompleted).toEqual(['Daily Level-ups Tier 3'])
    expect(e.treasure).toEqual([expect.stringMatching(/^You found an uncommon chest/)])
  })

  it('catch + epic crate (gold fish) + QUEST COMPLETE without level up', () => {
    const e = parse('catch-crate-gold-quest')
    expect(e.kind).toBe('catch')
    if (e.kind !== 'catch') return
    expect(e.items).toEqual([
      { name: 'Squid', count: 2 },
      { name: 'Turtle', count: 8 },
      { name: 'Dolphin', count: 3 },
      { name: 'Gold Fish', count: 5 }
    ])
    expect(e.xp).toBe(11912)
    expect(e.levelUp).toBeUndefined()
    expect(e.questsCompleted).toEqual(['Daily Artifact Hunter Tier 3'])
    expect(e.treasure).toEqual([expect.stringMatching(/^You found an epic crate/)])
  })

  it('inventory: balance, level, rare fish and fish value', () => {
    expect(parse('inventory')).toMatchObject({
      kind: 'inventory',
      balance: 136570161,
      level: 154,
      xpToNext: 1062500 - 986860,
      rod: 'Superium Rod',
      biome: 'Ocean',
      bait: { name: 'Magic Bait', count: 34414 },
      rare: { gold: 2353, emerald: 887, lava: 43, diamond: 77 },
      fishValue: 32180326
    })
  })

  it('quest list', () => {
    const e = parse('quests')
    expect(e.kind).toBe('quests')
    if (e.kind !== 'quests') return
    expect(e.quests).toEqual([
      { label: 'Daily Level-ups', progress: '2/3', done: false },
      { label: 'Daily Fishing', progress: '3225/5000', done: false },
      { label: 'Daily Artifact Hunter', progress: '19/25', done: false },
      { label: 'Pet Locator', progress: '0/1', done: false }
    ])
  })

  it('"Daily reward on cooldown! (10h 20m 25s)" is a cooldown, not a daily', () => {
    expect(parse('daily-cooldown')).toEqual({ kind: 'cooldown', waitMs: ((10 * 60 + 20) * 60 + 25) * 1000 })
  })

  it('edit of our catch by another player is accepted by toBotMessage (our interaction) and parses as unknown/error', () => {
    const bm = loadReal('edit-other-player')
    expect(bm.isEdit).toBe(true)
    expect(bm.embeds[0].title).toBe('Other Player')
    expect(parseMessage(bm, NOW).kind).not.toBe('catch')
  })
})
