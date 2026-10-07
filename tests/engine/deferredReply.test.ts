import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { toBotMessage, type LibMessageLike } from '../../src/main/discord/toBotMessage'
import { DEFAULT_CONFIG, type BotMessage, type Config } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

// Virtual Fisher defers some replies (e.g. while it generates a captcha): Discord first posts an
// empty "is thinking…" message (flag LOADING = 128), then edits it into the real reply.
const A = { guildId: 'g1', channelId: 'A' }
const LOADING: Partial<BotMessage> = { id: 'd1', content: '', embeds: [], loading: true }
const CAPTCHA_EDIT: Partial<BotMessage> = {
  id: 'd1',
  isEdit: true,
  embeds: [{ title: 'Player One', description: '### Anti-bot\n/verify <result>\nCode: **uVU6**', fields: [] }]
}
const CATCH_EDIT: Partial<BotMessage> = {
  id: 'd1',
  isEdit: true,
  embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }]
}

function setup() {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.sell.enabled = false
  cfg.daily.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  const client = new FakeDiscordClient()
  client.commands = client.commands.filter((c) => c.name !== 'boosts')
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state: new GameState(), rand: () => 0.5, logger })
  const fishes = () => client.sent.filter((s) => s.command === 'fish').length
  return { client, engine, fishes }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('deferred replies ("Virtual Fisher is thinking…")', () => {
  it('toBotMessage flags Discord LOADING messages', () => {
    const lib: LibMessageLike = {
      id: 'd1',
      channelId: 'c1',
      content: '',
      author: { id: '574652751745777665' },
      embeds: [],
      flags: 128,
      interaction: { user: { id: '111' } },
      mentions: { users: [] }
    }
    expect(toBotMessage(lib, '111')?.loading).toBe(true)
    expect(toBotMessage({ ...lib, flags: 0 }, '111')?.loading).toBe(false)
  })

  it('a deferred /fish is not answered yet: no other /fish while it is thinking, then the captcha freezes everything', async () => {
    const { client, engine, fishes } = setup()
    await engine.start(A)
    expect(fishes()).toBe(1)
    client.emitBot(LOADING)
    await tick(20_000) // longer than the fish delay and the normal 8 s timeout
    expect(fishes()).toBe(1)
    client.emitBot(CAPTCHA_EDIT)
    await tick(0)
    expect(engine.state).toBe('captcha')
    await tick(5 * 60_000)
    expect(fishes()).toBe(1)
  })

  it('the edit carrying the catch answers the /fish: exactly one next /fish', async () => {
    const { client, engine, fishes } = setup()
    await engine.start(A)
    client.emitBot(LOADING)
    await tick(4_000)
    client.emitBot(CATCH_EDIT)
    await tick(4_000) // fish delay ≈ 3 s
    expect(fishes()).toBe(2)
    await tick(10_000) // the second /fish is unanswered: still waiting, no burst
    expect(fishes()).toBe(2)
  })

  it('a "solve the captcha posted above" reminder keeps the actual captcha (code) on screen', async () => {
    const { client, engine } = setup()
    const shown: (string | undefined)[] = []
    engine.onState((s, info) => s === 'captcha' && shown.push(info?.captchaText))
    await engine.start(A)
    client.emitBot({ ...CAPTCHA_EDIT, isEdit: false, id: 'c1' })
    await tick(0)
    client.emitBot({
      id: 'r1',
      embeds: [{ title: 'Player One', description: 'To continue, solve the captcha posted above with the **/verify** command.', fields: [] }]
    })
    await tick(0)
    expect(engine.state).toBe('captcha')
    expect(shown.at(-1)).toContain('uVU6')
  })

  it('a deferred reply that never completes times out after 30 s, then fishing goes on', async () => {
    const { client, engine, fishes } = setup()
    await engine.start(A)
    client.emitBot(LOADING)
    await tick(25_000)
    expect(fishes()).toBe(1)
    await tick(10_000)
    expect(fishes()).toBe(2)
  })
})
