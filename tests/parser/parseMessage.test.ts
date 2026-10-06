import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BotMessage } from '../../src/shared/types'
import { parseMessage } from '../../src/main/parser'

const load = (name: string): BotMessage =>
  JSON.parse(readFileSync(resolve(__dirname, '../fixtures/messages', `${name}.json`), 'utf8'))

const NOW = 1_700_000_000_000

describe('parseMessage fixtures', () => {
  it('catch-basic', () => {
    const e = parseMessage(load('catch-basic'), NOW)
    expect(e.kind).toBe('catch')
    if (e.kind !== 'catch') return
    expect(e.items).toContainEqual({ name: 'Cod', count: 2 })
    expect(e.items).toContainEqual({ name: 'Salmon', count: 1 })
    expect(e.xp).toBe(45)
    expect(e.levelUp).toBeUndefined()
    expect(e.raw).toContain('Cod x2')
  })

  it('catch-levelup', () => {
    const e = parseMessage(load('catch-levelup'), NOW)
    expect(e.kind).toBe('catch')
    if (e.kind !== 'catch') return
    expect(e.levelUp).toBe(13)
    expect(e.xp).toBe(120)
    expect(e.treasure?.length).toBe(1)
    expect(e.items).toEqual([{ name: 'Cod', count: 1 }])
  })

  it('inventory', () => {
    const e = parseMessage(load('inventory'), NOW)
    expect(e).toMatchObject({
      kind: 'inventory',
      balance: 1234567,
      level: 12,
      xpToNext: 3450,
      rod: 'Wooden Rod',
      biome: 'Lake',
      bait: { name: 'Worms', count: 12 },
      rare: { gold: 3, emerald: 1, lava: 0, diamond: 2 }
    })
  })

  it('stats', () => {
    expect(parseMessage(load('stats'), NOW)).toEqual({
      kind: 'stats',
      crates: 14,
      quests: 7,
      trips: 88,
      dailyStreak: 5,
      totals: { gold: 9, emerald: 4, lava: 2, diamond: 1 }
    })
  })

  it('captcha-image', () => {
    const e = parseMessage(load('captcha-image'), NOW)
    expect(e.kind).toBe('captcha')
    if (e.kind === 'captcha') expect(e.imageUrl).toBe('https://cdn.example.test/captcha/abc123.png')
  })

  it('captcha-text-only', () => {
    const e = parseMessage(load('captcha-text-only'), NOW)
    expect(e.kind).toBe('captcha')
    if (e.kind === 'captcha') expect(e.imageUrl).toBeUndefined()
  })

  it('captcha-solved is not shadowed by the captcha rule', () => {
    expect(parseMessage(load('captcha-solved'), NOW).kind).toBe('captchaSolved')
  })

  it('captcha-failed', () => {
    const e = parseMessage(load('captcha-failed'), NOW)
    expect(e.kind).toBe('captchaFailed')
  })

  it('captcha detection looks at footer and fields too', () => {
    const m: BotMessage = {
      ...load('catch-basic'),
      embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [], footer: 'Complete the CAPTCHA' }]
    }
    expect(parseMessage(m, NOW).kind).toBe('captcha')
  })

  it('cooldown', () => {
    expect(parseMessage(load('cooldown'), NOW)).toEqual({ kind: 'cooldown', waitMs: 2400 })
    expect(parseMessage({ ...load('cooldown'), content: 'wait 3s' }, NOW)).toEqual({ kind: 'cooldown', waitMs: 3000 })
  })

  it('sell', () => {
    expect(parseMessage(load('sell'), NOW)).toEqual({ kind: 'sell', earned: 1234, xp: 56 })
  })

  it('boosts uses the injected clock', () => {
    expect(parseMessage(load('boosts'), NOW)).toEqual({
      kind: 'boosts',
      active: [
        { name: 'Fishing Buff', endsAt: NOW + 270000 },
        { name: 'Lucky Charm', endsAt: NOW + 3720000 }
      ]
    })
  })

  it('purchase', () => {
    expect(parseMessage(load('purchase'), NOW)).toEqual({ kind: 'purchase', item: 'Worms', amount: 5, cost: 250 })
  })

  it('daily', () => {
    const e = parseMessage(load('daily'), NOW)
    expect(e.kind).toBe('daily')
    if (e.kind === 'daily') expect(e.reward).toContain('$5,000')
  })

  it('quests', () => {
    expect(parseMessage(load('quests'), NOW)).toEqual({
      kind: 'quests',
      quests: [
        { label: 'Catch 50 fish', progress: '12/50', done: false },
        { label: 'Sell 20 fish', progress: '20/20', done: true },
        { label: 'Open 3 crates', progress: '1/3', done: false }
      ]
    })
  })

  it('error', () => {
    const e = parseMessage(load('error-funds'), NOW)
    expect(e.kind).toBe('error')
    if (e.kind === 'error') expect(e.text).toContain("don't have enough")
  })

  it('unknown embed', () => {
    expect(parseMessage(load('unknown-embed'), NOW)).toMatchObject({ kind: 'unknown', title: 'Fish of the day' })
  })
})

describe('parseMessage robustness', () => {
  const base = { id: '1', channelId: '2', ephemeral: false, isEdit: false }
  it('title-only embed without fields is unknown', () => {
    const m = { ...base, content: '', embeds: [{ title: 'X' }] } as unknown as BotMessage
    expect(parseMessage(m, NOW)).toMatchObject({ kind: 'unknown', title: 'X' })
  })
  it('empty message is unknown', () => {
    expect(parseMessage({ ...base, content: '', embeds: [] }, NOW).kind).toBe('unknown')
  })
  it('does not throw on malformed input', () => {
    expect(parseMessage({ ...base, embeds: undefined } as unknown as BotMessage, NOW).kind).toBe('unknown')
  })
})
