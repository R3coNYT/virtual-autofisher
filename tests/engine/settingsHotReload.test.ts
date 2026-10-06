import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { DEFAULT_CONFIG, type BotMessage, type Config } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

const oneFish: Partial<BotMessage> = { embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }] }
const SELL_REPLY: Partial<BotMessage> = { content: 'You sold your fish.' }

/** Mutable config read through a getter, like ConfigStore.get() after config.update. */
function setup(patch: (c: Config) => void = () => {}) {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.daily.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  cfg.fishing.jitterSec = 0
  patch(cfg)
  const client = new FakeDiscordClient()
  client.commands = client.commands.filter((c) => c.name !== 'boosts') // sent at start: keep /fish first
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state: new GameState(), rand: () => 0.5, logger })
  return { cfg, client, engine, names: () => client.sent.map((x) => x.command) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('settings hot reload (regression: Scheduler reads the config at every decision)', () => {
  it('uses the new fishing.baseCooldownSec for the next delay while running', async () => {
    const { cfg, client, engine } = setup((c) => {
      c.sell.enabled = false
      c.fishing.baseCooldownSec = 3
    })
    await engine.start({ guildId: 'g1', channelId: 'A' })
    await vi.advanceTimersByTimeAsync(100)
    expect(client.sent).toHaveLength(1) // first /fish

    cfg.fishing.baseCooldownSec = 20 // changed while running
    client.emitBot(oneFish) // reply -> next fish scheduled with the new value
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(client.sent).toHaveLength(2)
    engine.stop()
  })

  it('stops queueing /sell once sell.enabled is turned off', async () => {
    const { cfg, client, engine, names } = setup((c) => {
      c.sell.enabled = true
      c.sell.mode = 'catches'
      c.sell.every = 2
      c.fishing.baseCooldownSec = 3
    })
    await engine.start({ guildId: 'g1', channelId: 'A' })
    const loop = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(4000)
        const last = client.sent[client.sent.length - 1]?.command
        client.emitBot(last === 'sell' ? SELL_REPLY : oneFish)
      }
    }
    await loop(6)
    expect(names()).toContain('sell')

    cfg.sell.enabled = false
    const before = names().filter((n) => n === 'sell').length
    await loop(10)
    expect(names().filter((n) => n === 'sell').length).toBe(before)
    engine.stop()
  })
})
