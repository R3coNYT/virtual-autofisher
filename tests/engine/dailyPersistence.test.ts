import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { StateStore } from '../../src/main/persist/StateStore'
import { wireStatePersistence } from '../../src/main/persist/wireStatePersistence'
import { DEFAULT_CONFIG, type BotMessage, type Config } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

const A = { guildId: 'g1', channelId: 'A' }
const H = 3_600_000
const oneFish: Partial<BotMessage> = { embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }] }
const DAILY_OK: Partial<BotMessage> = { content: 'You claimed your daily reward: $5,000!' }
const PROFILE: Partial<BotMessage> = {
  embeds: [
    {
      title: 'Inventory of Player One',
      description: 'Balance: $2,000\nFish Value: $500\nLevel 12 - 100/200 XP to next level',
      fields: []
    }
  ]
}
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const noEngine = { onSessionEnd: () => () => {} }

function setup(state = new GameState(), patch: (c: Config) => void = () => {}) {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.sell.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  cfg.daily.enabled = true
  patch(cfg)
  const client = new FakeDiscordClient()
  client.commands = client.commands.filter((c) => c.name !== 'boosts')
  const orig = client.sendSlash.bind(client)
  client.sendSlash = async (channelId, command, options) => {
    await orig(channelId, command, options)
    queueMicrotask(() => client.emitBot(command === 'daily' ? DAILY_OK : command === 'profile' ? PROFILE : oneFish))
  }
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state, rand: () => 0.5 })
  const dailies = () => client.sent.filter((s) => s.command === 'daily').length
  return { client, engine, state, dailies, names: () => client.sent.map((s) => s.command) }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'af-daily-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('daily gating with nextDailyAt', () => {
  it('unknown nextDailyAt → /daily at start; success → next one 24 h later', async () => {
    // only /daily matters here: hourly fishing keeps 24 simulated hours cheap (slow CI runners)
    const { engine, state, dailies, names } = setup(undefined, (c) => {
      c.fishing.baseCooldownSec = 3600
    })
    const t0 = Date.now()
    await engine.start(A)
    expect(names()).toEqual(['daily'])
    await tick(5_000)
    expect(state.nextDailyAt).toBeGreaterThanOrEqual(t0 + 24 * H)
    await tick(23 * H)
    expect(dailies()).toBe(1)
    await tick(H + 15 * 60_000)
    expect(dailies()).toBe(2)
  })

  it('nextDailyAt in the past → /daily at start', async () => {
    const state = new GameState()
    state.hydrate({ nextDailyAt: Date.now() - 1 })
    const { engine, names } = setup(state)
    await engine.start(A)
    expect(names()).toEqual(['daily'])
  })

  it('nextDailyAt in 3 h → no /daily at start, sent once 1–5 min after it', async () => {
    const state = new GameState()
    const t0 = Date.now()
    state.hydrate({ nextDailyAt: t0 + 3 * H })
    const { engine, dailies, names } = setup(state)
    await engine.start(A)
    expect(names()).toEqual(['fish'])
    await tick(3 * H)
    expect(dailies()).toBe(0)
    await tick(5 * 60_000) // rand 0.5 → 3 min after nextDailyAt
    expect(dailies()).toBe(1)
  })

  it('a session that ends before nextDailyAt never sends /daily', async () => {
    const state = new GameState()
    state.hydrate({ nextDailyAt: Date.now() + 2 * H })
    const { engine, dailies } = setup(state)
    await engine.start(A)
    await tick(H)
    engine.stop()
    await tick(3 * H)
    expect(dailies()).toBe(0)
  })

  it('across restarts: closed 12 h with the next daily due in 3 h → the next start runs /daily', async () => {
    const t0 = Date.now()
    // first run: next daily known (e.g. from a cooldown reply), saved as soon as it changes
    const first = new GameState()
    wireStatePersistence({ state: first, engine: noEngine, store: new StateStore(dir, logger()), logger: logger() })
    first.setNextDailyAt(t0 + 3 * H)
    // app closed for 12 h, then opened again
    vi.setSystemTime(t0 + 12 * H)
    const second = new GameState()
    wireStatePersistence({ state: second, engine: noEngine, store: new StateStore(dir, logger()), logger: logger() })
    expect(second.nextDailyAt).toBe(t0 + 3 * H)
    const { engine, names } = setup(second)
    await engine.start(A)
    expect(names()).toEqual(['daily'])
  })

  it('after a restart, a next daily still 3 h away is honoured', async () => {
    const t0 = Date.now()
    new StateStore(dir, logger()).save({ account: new GameState().persisted().account, nextDailyAt: t0 + 3 * H })
    const state = new GameState()
    wireStatePersistence({ state, engine: noEngine, store: new StateStore(dir, logger()), logger: logger() })
    const { engine, names } = setup(state)
    await engine.start(A)
    await tick(60_000)
    expect(names()).not.toContain('daily')
  })
})

describe('wireStatePersistence', () => {
  it('hydrates at boot, saves when nextDailyAt changes and at session end, never the session', async () => {
    const store = new StateStore(dir, logger())
    store.save({ account: { ...new GameState().persisted().account, balance: 777, level: 3 }, nextDailyAt: null })
    const state = new GameState()
    const { engine } = setup(state, (c) => {
      c.profile.refreshMin = 5
      c.daily.enabled = false
    })
    const save = vi.spyOn(store, 'save')
    wireStatePersistence({ state, engine, store, logger: logger() })
    // shown before any login or /profile
    expect(state.snapshot().account).toMatchObject({ balance: 777, level: 3 })
    expect(state.snapshot().session.catches).toBe(0)

    state.setNextDailyAt(Date.now() + H)
    expect(save).toHaveBeenCalledTimes(1)

    await engine.start(A)
    await tick(10_000) // the start /profile refreshes the account
    expect(state.snapshot().account.balance).toBe(2_000)
    expect(save).toHaveBeenCalledTimes(2) // the new account values are saved without waiting for the end
    engine.stop()
    expect(save).toHaveBeenCalledTimes(3)
    const saved = store.load()!
    expect(saved.account).toMatchObject({ balance: 2_000, level: 12, fishValue: 500 })
    expect(saved.nextDailyAt).toBe(state.nextDailyAt)
    expect(JSON.stringify(saved)).not.toMatch(/catches|session|token/i)
  })

  it('a failing save is logged, never thrown', () => {
    const store = new StateStore(dir, logger())
    vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full')
    })
    const log = logger()
    const state = new GameState()
    const { save } = wireStatePersistence({ state, engine: noEngine, store, logger: log })
    expect(() => save()).not.toThrow()
    expect(() => state.setNextDailyAt(5)).not.toThrow()
    expect(log.error).toHaveBeenCalled()
  })
})
