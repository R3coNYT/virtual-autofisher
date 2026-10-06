import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { DEFAULT_CONFIG, type BotMessage, type Config } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

// Auto buffs as one cycle: buy fish + treasure back to back (nothing in between), then /boosts;
// wait until BOTH buffs are over; start again.
const A = { guildId: 'g1', channelId: 'A' }
const MIN = 60_000
const oneFish: Partial<BotMessage> = { embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }] }
const bought = (item: string): Partial<BotMessage> => ({ content: `You bought 1x ${item} for $1,000!` })
const boosts = (description: string): Partial<BotMessage> => ({
  embeds: [{ title: 'Active Boosts', description, fields: [] }]
})

function setup() {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.sell.enabled = false
  cfg.daily.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  cfg.buffs = { enabled: true, lengthMin: 5 }
  const client = new FakeDiscordClient()
  const state = new GameState()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state, rand: () => 0.5, logger })
  const seq = () => client.sent.map((s) => (s.command === 'buy' ? `buy ${s.options?.item}` : s.command))
  return { client, engine, seq }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** Advances `ms`, answering each new command with `reply(cmd)` (null = no answer). */
async function run(client: FakeDiscordClient, ms: number, reply: (cmd: string, item?: string) => Partial<BotMessage> | null, step = 500) {
  let answered = client.sent.length
  for (let t = 0; t < ms; t += step) {
    while (answered < client.sent.length) {
      const s = client.sent[answered++]
      const r = reply(s.command, s.options?.item as string | undefined)
      if (r) client.emitBot(r)
    }
    await tick(step)
  }
}

/** Index of the n-th occurrence of `x` in `list`. */
const nth = (list: string[], x: string, n = 1) => list.reduce((acc, v, i) => (acc.found < n && v === x ? { found: acc.found + 1, at: i } : acc), { found: 0, at: -1 }).at

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('auto buffs cycle', () => {
  it('buys fish then treasure back to back, then /boosts, with no /fish in between', async () => {
    const { client, engine, seq } = setup()
    let postBuy = 'None'
    await engine.start(A)
    await run(client, 60_000, (cmd, item) => {
      if (cmd === 'boosts') return boosts(postBuy)
      if (cmd === 'buy') {
        if (item === 'treasure5m') postBuy = 'Fish Boost: **4m 55s**\nTreasure Boost: **4m 58s**'
        return bought(item ?? '')
      }
      return oneFish
    })
    const s = seq()
    const i = s.indexOf('buy fish5m')
    expect(i).toBeGreaterThan(-1)
    expect(s.slice(i, i + 3)).toEqual(['buy fish5m', 'buy treasure5m', 'boosts'])
  })

  it('waits until BOTH buffs are over before buying again, then repeats the cycle', async () => {
    const { client, engine, seq } = setup()
    await engine.start(A)
    // start check: nothing active → cycle; after the buys, /boosts lists fish 5 min and treasure 8 min
    let after = false
    await run(client, 60_000, (cmd, item) => {
      if (cmd === 'boosts') return boosts(after ? 'Fish Boost: **5m**\nTreasure Boost: **8m**' : 'None')
      if (cmd === 'buy') {
        if (item === 'treasure5m') after = true
        return bought(item ?? '')
      }
      return oneFish
    })
    expect(seq().filter((x) => x.startsWith('buy'))).toEqual(['buy fish5m', 'buy treasure5m'])
    // 7 min later the fish buff is over but not the treasure one: still no buy
    await run(client, 7 * MIN, () => oneFish)
    expect(seq().filter((x) => x.startsWith('buy'))).toHaveLength(2)
    // once both are over (8 min + grace) the cycle starts again: both buys then /boosts
    await run(client, 2 * MIN, (cmd, item) => (cmd === 'buy' ? bought(item ?? '') : cmd === 'boosts' ? boosts('Fish Boost: **5m**\nTreasure Boost: **5m**') : oneFish))
    const s = seq()
    const second = nth(s, 'buy fish5m', 2)
    expect(second).toBeGreaterThan(-1)
    expect(s.slice(second, second + 3)).toEqual(['buy fish5m', 'buy treasure5m', 'boosts'])
  })

  it('one buff still active at start → nothing bought until it is over, then both', async () => {
    const { client, engine, seq } = setup()
    await engine.start(A)
    expect(seq()[0]).toBe('boosts')
    client.emitBot(boosts('Fish Boost: **10m**'))
    await run(client, 10 * MIN - 1000, () => oneFish)
    expect(seq().some((x) => x.startsWith('buy'))).toBe(false)
    await run(client, MIN, (cmd, item) => (cmd === 'buy' ? bought(item ?? '') : cmd === 'boosts' ? boosts('None') : oneFish))
    const s = seq()
    const i = s.indexOf('buy fish5m')
    expect(s.slice(i, i + 3)).toEqual(['buy fish5m', 'buy treasure5m', 'boosts'])
  })

  it('post-buy /boosts not listing the buffs → waits the buff length from the purchase, then repeats', async () => {
    const { client, engine, seq } = setup()
    await engine.start(A)
    await run(client, 60_000, (cmd, item) => (cmd === 'buy' ? bought(item ?? '') : cmd === 'boosts' ? boosts('None') : oneFish))
    expect(seq().filter((x) => x === 'buy fish5m')).toHaveLength(1)
    await run(client, 4 * MIN, () => oneFish) // not before 5 min
    expect(seq().filter((x) => x === 'buy fish5m')).toHaveLength(1)
    await run(client, MIN + 30_000, (cmd, item) => (cmd === 'buy' ? bought(item ?? '') : cmd === 'boosts' ? boosts('None') : oneFish))
    expect(seq().filter((x) => x === 'buy fish5m')).toHaveLength(2)
  })
})
