import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { DEFAULT_CONFIG, type BotMessage, type Config, type EngineState } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'
import { realForEngine } from '../helpers/realFixture'

/** Fixture without id/channelId so FakeDiscordClient delivers it to the active channel. */
const msg = (name: string): Partial<BotMessage> => {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/messages', `${name}.json`), 'utf8'))
  delete raw.id
  delete raw.channelId
  return raw
}
const CATCH = msg('catch-basic') // 3 fish (Cod x2, Salmon x1)
const CAPTCHA = msg('captcha-image')
const SOLVED = msg('captcha-solved')
const FAILED = msg('captcha-failed')
const FUNDS = msg('error-funds')
const SELL = msg('sell')
const cooldown = (sec: number): Partial<BotMessage> => ({ content: `You must wait ${sec} seconds before fishing again.` })
const oneFish: Partial<BotMessage> = { embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }] }

const A = { guildId: 'g1', channelId: 'A' }
const B = { guildId: 'g1', channelId: 'B' }
// rand = 0.5: fishDelayMs = 3.5 - 1.1774 * 0.4 ≈ 3.029 s ; randomBetweenMs(a, b) = midpoint.
const FISH_DELAY = 3029

function setup(patch: (c: Config) => void = () => {}) {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.sell.enabled = false
  cfg.daily.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  patch(cfg)
  const client = new FakeDiscordClient()
  // /boosts is sent at every start: tests that are not about buffs drop it so /fish stays first
  if (!cfg.buffs.enabled) client.commands = client.commands.filter((c) => c.name !== 'boosts')
  const state = new GameState()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state, rand: () => 0.5, logger })
  const states: { s: EngineState; info?: { reason?: string; captchaImageUrl?: string; captchaText?: string } }[] = []
  engine.onState((s, info) => states.push({ s, info }))
  const names = () => client.sent.map((x) => x.command)
  return { cfg, client, state, engine, states, names, logger }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** Advances `ms`, answering every new command with `reply(command)` (null = no answer). */
async function run(
  client: FakeDiscordClient,
  ms: number,
  reply: (cmd: string) => Partial<BotMessage> | null = () => oneFish,
  step = 500
) {
  let answered = client.sent.length
  for (let t = 0; t < ms; t += step) {
    while (answered < client.sent.length) {
      const r = reply(client.sent[answered++].command)
      if (r) client.emitBot(r)
    }
    await tick(step)
  }
}
const boostsMsg = (description: string): Partial<BotMessage> => ({
  embeds: [{ title: 'Active boosts', description, fields: [] }]
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Engine', () => {
  it('normal fishing: second /fish after the delay, never before minGap', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    expect(engine.state).toBe('running')
    expect(names()).toEqual(['fish'])
    expect(client.sent[0]).toEqual({ channelId: 'A', command: 'fish', options: undefined })

    await tick(500)
    client.emitBot(CATCH)
    await tick(FISH_DELAY - 10) // delay not elapsed
    expect(names()).toEqual(['fish'])
    await tick(11) // t = 3.530 s, second /fish went out at ≈ 3.529 s
    expect(names()).toEqual(['fish', 'fish'])

    // a cooldown of 0 asks for a /fish 0.6 s later: minGap (2.5 s after the last send) still wins
    client.emitBot(cooldown(0))
    await tick(2498)
    expect(names()).toHaveLength(2)
    await tick(2)
    expect(names()).toHaveLength(3)
  })

  it('sell after N catches with options from SlashCommandInfo (amount = all)', async () => {
    const { client, engine, names } = setup((c) => {
      c.sell = { enabled: true, mode: 'catches', every: 3 }
    })
    await engine.start(A)
    client.emitBot(CATCH) // 3 fish → sell
    await tick(2500)
    expect(names()).toEqual(['fish', 'sell'])
    expect(client.sent[1].options).toEqual({ amount: 'all' })
  })

  it('captcha blocks everything: nothing sent for 10 minutes, never a verify', async () => {
    const { client, engine, names, states } = setup((c) => {
      c.sell = { enabled: true, mode: 'catches', every: 1 }
      c.daily.enabled = true
      c.quests.enabled = true
      c.profile.refreshMin = 1
      c.buffs.enabled = true
      c.breaks.enabled = true
    })
    await engine.start(A)
    const before = client.sent.length
    client.emitBot(CAPTCHA)
    expect(engine.state).toBe('captcha')
    expect(states.at(-1)).toEqual({
      s: 'captcha',
      info: { captchaImageUrl: 'https://cdn.example.test/captcha/abc123.png', captchaText: expect.stringMatching(/captcha/i) }
    })
    // even bot traffic that would normally trigger commands must not
    client.emitBot(CATCH)
    client.emitBot(cooldown(1))
    await tick(10 * 60_000)
    expect(client.sent.length).toBe(before)
    expect(names()).not.toContain('verify')
    expect(engine.state).toBe('captcha')
    // pause/resume from the UI cannot escape the captcha
    engine.resume()
    engine.pause()
    engine.sendManual('fish')
    await tick(60_000)
    expect(client.sent.length).toBe(before)
    expect(engine.state).toBe('captcha')
  })

  it('captcha delivered via a message edit also blocks', async () => {
    const { client, engine } = setup()
    await engine.start(A)
    client.emitBot({ ...CAPTCHA, isEdit: true })
    expect(engine.state).toBe('captcha')
    await tick(5 * 60_000)
    expect(client.sent).toHaveLength(1)
  })

  it('captcha resolution: verify with the answer, running only after 5–15 s', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA) // non-edit: also answers the in-flight /fish
    engine.submitCaptcha('ABC123')
    await tick(2500)
    expect(client.sent.at(-1)).toEqual({ channelId: 'A', command: 'verify', options: { answer: 'ABC123' } })

    client.emitBot(FAILED)
    expect(engine.state).toBe('captcha')
    engine.regenCaptcha()
    await tick(2500)
    expect(client.sent.at(-1)?.options).toEqual({ answer: 'regen' })

    client.emitBot(SOLVED)
    await tick(4_900)
    expect(engine.state).toBe('captcha')
    const n = names().length
    await tick(10_200) // rand 0.5 → 10 s
    expect(engine.state).toBe('running')
    await tick(FISH_DELAY + 100)
    expect(names().length).toBeGreaterThan(n)
    expect(names().at(-1)).toBe('fish')
  })

  it('captchaFailed re-emits the captcha state with the bot message', async () => {
    const { client, engine, states } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA)
    client.emitBot(FAILED)
    expect(states.at(-1)?.s).toBe('captcha')
    expect(states.at(-1)?.info?.captchaText).toMatch(/incorrect/i)
  })

  it('a new captcha while in captcha updates it and cancels a pending resume', async () => {
    const { client, engine, states, state } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA)
    client.emitBot(SOLVED)
    await tick(5_000)
    client.emitBot({ ...CAPTCHA, embeds: [{ title: 'Captcha', description: 'New code', fields: [], imageUrl: 'https://cdn.example.test/2.png' }] })
    expect(states.at(-1)?.info?.captchaImageUrl).toBe('https://cdn.example.test/2.png')
    await tick(60_000)
    expect(engine.state).toBe('captcha')
    expect(client.sent).toHaveLength(1)
    expect(state.snapshot().session.captchas).toBe(1)
  })

  it('submitCaptcha / regenCaptcha are no-ops outside the captcha state', async () => {
    const { engine, names } = setup()
    await engine.start(A)
    engine.submitCaptcha('X')
    engine.regenCaptcha()
    await tick(30_000)
    expect(names()).not.toContain('verify')
  })

  it('cooldown: the next /fish goes out at the earliest waitMs later', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    await tick(3000)
    client.emitBot(cooldown(2.4))
    await tick(2399)
    expect(names()).toEqual(['fish'])
    await tick(1000) // + 0.6 s random (rand 0.5 of 0.2–1 s)
    expect(names()).toEqual(['fish', 'fish'])
  })

  it('disconnect pauses (network), reconnect resumes, 2 min without reconnect → error', async () => {
    const { client, engine, states, names } = setup()
    await engine.start(A)
    client.emitDisconnect()
    expect(engine.state).toBe('paused')
    expect(states.at(-1)?.info?.reason).toBe('network')
    client.emitReconnect()
    expect(engine.state).toBe('running')

    client.emitDisconnect()
    await tick(119_000)
    expect(engine.state).toBe('paused')
    await tick(1_000)
    expect(engine.state).toBe('error')
    expect(states.at(-1)?.info?.reason).toBeTruthy()
    const n = names().length
    await tick(60_000)
    expect(names()).toHaveLength(n)
  })

  it('a user pause is not lifted by a reconnect', async () => {
    const { client, engine } = setup()
    await engine.start(A)
    engine.pause()
    client.emitDisconnect()
    client.emitReconnect()
    expect(engine.state).toBe('paused')
  })

  it('3 consecutive timeouts → paused (noResponse)', async () => {
    const { engine, states, names } = setup()
    await engine.start(A)
    await tick(8_000) // timeout 1 → fish rescheduled
    expect(engine.state).toBe('running')
    await tick(FISH_DELAY + 8_000) // timeout 2
    expect(engine.state).toBe('running')
    await tick(FISH_DELAY + 8_000) // timeout 3
    expect(engine.state).toBe('paused')
    expect(states.at(-1)?.info?.reason).toBe('noResponse')
    expect(names()).toEqual(['fish', 'fish', 'fish'])
  })

  it('channel switch: queue emptied and every later command targets B', async () => {
    const { client, engine } = setup((c) => {
      c.daily.enabled = true
      c.quests.enabled = true
    })
    await engine.start(A) // fish sent, daily + quests queued
    expect(client.sent.map((s) => s.channelId)).toEqual(['A'])
    await engine.start(B)
    expect(client.activeChannel).toBe('B')
    for (let t = 0; t < 20_000; t += 500) {
      if (client.sent.length > 1) client.emitBot({ content: 'ok' }) // answer whatever is in flight
      await tick(500)
    }
    const after = client.sent.slice(1)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((s) => s.channelId === 'B')).toBe(true)
    expect(after.map((s) => s.command)).toContain('fish')
  })

  it('missing /fish → error', async () => {
    const { client, engine, states, names } = setup()
    client.commands = client.commands.filter((c) => c.name !== 'fish')
    await engine.start(A)
    expect(engine.state).toBe('error')
    expect(states.at(-1)?.info?.reason).toBe('Command /fish not found in this server')
    expect(names()).toEqual([])
  })

  it('goes through connecting and lists available commands', async () => {
    const { engine, states } = setup()
    await engine.start(A)
    expect(states.map((x) => x.s)).toEqual(['connecting', 'running'])
    expect(engine.availableCommands.map((c) => c.name)).toContain('verify')
  })

  it('pause / resume: nothing is sent while paused', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    engine.pause()
    expect(engine.state).toBe('paused')
    client.emitBot(CATCH)
    engine.sendManual('profile')
    await tick(5 * 60_000)
    expect(names()).toEqual(['fish'])
    engine.resume()
    expect(engine.state).toBe('running')
    await tick(0)
    expect(names()).toEqual(['fish', 'profile'])
    client.emitBot({ content: 'Profile' })
    await tick(FISH_DELAY + 100)
    expect(names().filter((n) => n === 'fish').length).toBeGreaterThan(1)
  })

  it('human breaks: resting after workMin, back to running after restMin, nothing sent while resting', async () => {
    const { client, engine, names } = setup((c) => {
      c.breaks = { enabled: true, workMin: 2, workJitterMin: 1, restMin: 3, restJitterMin: 1 }
    })
    await engine.start(A)
    // keep the bot answering every /fish
    let answered = 0
    const answer = async () => {
      while (answered < client.sent.length) {
        answered++
        client.emitBot(oneFish)
      }
    }
    for (let t = 0; t < 119_000; t += 1000) {
      await answer()
      await tick(1000)
    }
    expect(engine.state).toBe('running')
    await answer()
    await tick(1_000) // 2 min of work (rand 0.5 → exactly workMin)
    expect(engine.state).toBe('resting')
    await answer()
    const n = client.sent.length
    await tick(3 * 60_000 - 1)
    expect(client.sent.length).toBe(n)
    expect(engine.state).toBe('resting')
    await tick(1)
    expect(engine.state).toBe('running')
    await tick(FISH_DELAY + 10)
    expect(names().length).toBeGreaterThan(n)
  })

  it('session limit: idle after sessionLimitH hours', async () => {
    const { client, engine } = setup((c) => {
      c.sessionLimitH = 1
    })
    await engine.start(A)
    await tick(59 * 60_000)
    expect(engine.state).not.toBe('idle')
    await tick(60_000 + 25_000) // graceful stop: at most 25 s of /profile + /quests
    expect(engine.state).toBe('idle')
    expect(client.activeChannel).toBeNull()
  })

  it('insufficient funds after a buff buy: no buff queued for 30 min', async () => {
    const { client, engine, names } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A) // /boosts first (fish queued); buff timers armed from its reply
    expect(names()).toEqual(['boosts'])
    client.emitBot({ embeds: [{ title: 'Active boosts', description: 'None', fields: [] }] })
    await tick(0)
    // no boost active → buy both buffs
    const buys = () => client.sent.filter((s) => s.command === 'buy')
    for (let i = 0; i < 10 && buys().length === 0; i++) {
      await tick(2500)
    }
    expect(buys()[0].options).toEqual({ item: 'fish5m', amount: 1 })
    client.emitBot(FUNDS) // answers the fish buff buy
    const count = buys().length
    // the treasure buy was queued before the error and may still go out; nothing after it
    // answer everything else for 29 min: no further buff buys
    let answered = client.sent.length
    for (let t = 0; t < 29 * 60_000; t += 2000) {
      while (answered < client.sent.length) {
        answered++
        client.emitBot(oneFish)
      }
      await tick(2000)
    }
    expect(buys().slice(count).map((b) => b.options?.item)).toEqual(['treasure5m'])
    // after 30 min buff buys come back
    for (let t = 0; t < 2 * 60_000; t += 2000) {
      while (answered < client.sent.length) {
        answered++
        client.emitBot(oneFish)
      }
      await tick(2000)
    }
    expect(buys().length).toBeGreaterThan(count + 1)
  })

  it('buffs wait for the /boosts reply: active fish boost → no fish buy before it ends', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A)
    const buys = (item: string) => client.sent.filter((s) => s.command === 'buy' && s.options?.item === item)
    expect(client.sent.at(-1)?.command).toBe('boosts') // sent first at start
    client.emitBot(boostsMsg('Fish Boost: 10m'))
    await run(client, 10 * 60_000 - 1000, (cmd) => (cmd === 'boosts' ? null : oneFish))
    expect(buys('fish5m')).toHaveLength(0)
    expect(buys('treasure5m').length).toBeGreaterThan(0) // absent → bought 5–30 s after the reply
    await run(client, 60_000)
    expect(buys('fish5m')).toHaveLength(1)
  })

  it('boosts reply with no active boost → buys 5–30 s later, not before', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A) // /boosts sent first
    client.emitBot(boostsMsg('None'))
    await run(client, 4_500)
    expect(client.sent.some((s) => s.command === 'buy')).toBe(false)
    await run(client, 30_000)
    expect(client.sent.filter((s) => s.command === 'buy').map((s) => s.options?.item).sort()).toEqual([
      'fish5m',
      'treasure5m'
    ])
  })

  it('no /boosts command → buffs armed by the 5–30 s fallback', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    client.commands = client.commands.filter((c) => c.name !== 'boosts')
    await engine.start(A)
    await run(client, 4_500)
    expect(client.sent.some((s) => s.command === 'buy')).toBe(false)
    await run(client, 30_000)
    expect(client.sent.filter((s) => s.command === 'buy')).toHaveLength(2)
  })

  it('a /boosts that never answers (even retried) falls back to buying', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A)
    await run(client, 60_000, (cmd) => (cmd === 'boosts' ? null : oneFish))
    expect(client.sent.filter((s) => s.command === 'boosts')).toHaveLength(2)
    expect(client.sent.filter((s) => s.command === 'buy')).toHaveLength(2)
  })

  it('/boosts answered by an unknown message → buffs bought 5–30 s later', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A)
    expect(client.sent.at(-1)?.command).toBe('boosts')
    client.emitBot({ content: 'Something the parser does not know' })
    await run(client, 4_500)
    expect(client.sent.some((s) => s.command === 'buy')).toBe(false)
    await run(client, 30_000)
    expect(client.sent.filter((s) => s.command === 'buy')).toHaveLength(2)
  })

  it('captcha replying to an in-flight /boosts → boosts re-requested after resume, buffs bought', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A)
    expect(client.sent.at(-1)?.command).toBe('boosts')
    client.emitBot(CAPTCHA) // the reply to /boosts is the captcha
    const n = client.sent.length
    await tick(10 * 60_000)
    expect(client.sent).toHaveLength(n) // safety: still nothing during the captcha
    client.emitBot(SOLVED)
    await tick(10_000)
    expect(engine.state).toBe('running')
    await run(client, 60_000, (cmd) => (cmd === 'boosts' ? boostsMsg('None') : oneFish))
    expect(client.sent.slice(n).filter((s) => s.command === 'boosts')).toHaveLength(1)
    expect(client.sent.filter((s) => s.command === 'buy')).toHaveLength(2)
  })

  it('captcha via edit while /boosts is in flight → re-requested after resume', async () => {
    const { client, engine } = setup((c) => {
      c.buffs = { enabled: true, lengthMin: 5 }
    })
    await engine.start(A) // /boosts in flight
    client.emitBot({ ...CAPTCHA, isEdit: true })
    const n = client.sent.length
    await tick(5 * 60_000) // the in-flight /boosts times out during the captcha
    expect(client.sent).toHaveLength(n)
    client.emitBot(SOLVED)
    await tick(10_000)
    await run(client, 60_000, (cmd) => (cmd === 'boosts' ? boostsMsg('None') : oneFish))
    expect(client.sent.slice(n).filter((s) => s.command === 'boosts')).toHaveLength(1)
    expect(client.sent.filter((s) => s.command === 'buy')).toHaveLength(2)
  })

  it('a retry copy of daily dropped by a captcha is sent after the resume', async () => {
    const { client, engine } = setup((c) => {
      c.daily.enabled = true
    })
    await engine.start(A)
    expect(client.sent.at(-1)?.command).toBe('daily') // data first, fish queued
    client.emitRateLimited(30_000) // keeps the retry copy waiting in the queue
    await tick(8_500) // daily times out → retry copy queued, held by the rate limit
    const dailies = () => client.sent.filter((s) => s.command === 'daily').length
    expect(dailies()).toBe(1)
    client.emitBot({ ...CAPTCHA, isEdit: true })
    const n = client.sent.length
    await tick(10 * 60_000)
    expect(client.sent).toHaveLength(n)
    client.emitBot(SOLVED)
    await tick(10_000)
    await run(client, 40_000)
    expect(dailies()).toBe(2)
  })

  it('a timed-out maintenance command is re-sent once, then not again', async () => {
    const { client, engine } = setup((c) => {
      c.daily.enabled = true
    })
    await engine.start(A)
    await run(client, 60_000, (cmd) => (cmd === 'daily' ? null : oneFish))
    expect(client.sent.filter((s) => s.command === 'daily')).toHaveLength(2)
  })

  it('a daily answered by a captcha is sent again after the resume', async () => {
    const { client, engine } = setup((c) => {
      c.daily.enabled = true
    })
    await engine.start(A) // daily in flight, fish queued
    expect(client.sent.map((s) => s.command)).toEqual(['daily'])
    client.emitBot(CAPTCHA) // answers the daily, queue cleared (fish dropped)
    await tick(60_000)
    expect(client.sent.map((s) => s.command)).toEqual(['daily'])
    client.emitBot(SOLVED)
    await tick(10_000) // resume
    expect(engine.state).toBe('running')
    await run(client, 40_000)
    expect(client.sent.filter((s) => s.command === 'daily')).toHaveLength(2)
  })

  it('start(B) during a captcha is refused and keeps the captcha', async () => {
    const { client, engine, logger } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA)
    await engine.start(B)
    expect(engine.state).toBe('captcha')
    expect(client.activeChannel).toBe('A')
    expect(logger.warn).toHaveBeenCalled()
    await tick(60_000)
    expect(client.sent).toHaveLength(1)
  })

  it('rate limit: nothing sent during retry_after, then minGap × 1.5 for 5 min', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    client.emitRateLimited(5000)
    client.emitBot(cooldown(0)) // fish wanted ≈ 0.6 s later
    await tick(4999)
    expect(names()).toHaveLength(1)
    await tick(2)
    expect(names()).toHaveLength(2)
    client.emitBot(cooldown(0))
    await tick(3748) // 2.5 s × 1.5 = 3.75 s after the send at t = 5 s
    expect(names()).toHaveLength(2)
    await tick(2)
    expect(names()).toHaveLength(3)
  })

  it('exceptions in handlers pause the engine instead of throwing', async () => {
    const { client, engine, state, logger } = setup()
    await engine.start(A)
    vi.spyOn(state, 'apply').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => client.emitBot(CATCH)).not.toThrow()
    expect(engine.state).toBe('paused')
    expect(logger.error).toHaveBeenCalled()
  })

  it('onSessionEnd delivers the summary once on stop, and a throwing listener is contained', async () => {
    const { client, engine, state, logger } = setup()
    const got: { catches: number; endedAt: number }[] = []
    engine.onSessionEnd(() => {
      throw new Error('boom')
    })
    engine.onSessionEnd((s) => got.push(s))
    await engine.start(A)
    client.emitBot(CATCH)
    expect(() => engine.stop()).not.toThrow()
    engine.stop()
    expect(got).toHaveLength(1)
    expect(got[0].catches).toBe(3)
    expect(got[0].endedAt).toBeGreaterThan(0)
    // the finished session stays visible until the next start
    expect(state.snapshot().session.catches).toBe(3)
    expect(logger.error).toHaveBeenCalled()
  })

  it('stop → idle and nothing else is sent', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    engine.stop()
    expect(engine.state).toBe('idle')
    expect(client.activeChannel).toBeNull()
    await tick(60_000)
    expect(names()).toEqual(['fish'])
  })

  it('profile refresh after a sell', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    client.emitBot(SELL)
    await tick(2500)
    expect(names()).toEqual(['fish', 'profile'])
  })
})

/** Makes the fake bot answer every command right after it is sent (null = no answer). */
function autoReply(client: FakeDiscordClient, reply: (cmd: string) => Partial<BotMessage> | null) {
  const orig = client.sendSlash.bind(client)
  client.sendSlash = async (channelId, command, options) => {
    await orig(channelId, command, options)
    queueMicrotask(() => {
      const r = reply(command)
      if (r) client.emitBot(r)
    })
  }
}

describe('Engine: cooldown replies', () => {
  it('a daily answered "please wait 20h 12m" leaves fishing alone and re-arms the daily ~20 h later', async () => {
    const { client, engine, cfg, names, logger } = setup((c) => {
      c.daily.enabled = true
    })
    autoReply(client, (cmd) =>
      cmd === 'daily' ? { content: 'You already claimed your daily reward, please wait 20h 12m.' } : oneFish
    )
    const dailies = () => names().filter((n) => n === 'daily').length
    await engine.start(A)
    await tick(60_000)
    expect(dailies()).toBe(1)
    // fishing kept its normal pace (≈ every 3 s), it was not pushed back by the daily's cooldown
    expect(names().filter((n) => n === 'fish').length).toBeGreaterThanOrEqual(15)
    expect(engine.state).toBe('running')
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('/daily on cooldown'))

    cfg.fishing.baseCooldownSec = 600 // fewer fish over the next 20 h
    const rearmAt = (20 * 60 + 12) * 60_000 + 180_000 // daily sent first at 0 s; + wait + 3 min (rand 0.5 of 1–5)
    await tick(rearmAt - 60_000 - 30_000)
    expect(dailies()).toBe(1)
    await tick(60_000)
    expect(dailies()).toBe(2)
  })

  it('a short "wait" in reply to a maintenance command re-sends it once after the wait, then re-arms its slot', async () => {
    const { client, engine, names } = setup((c) => {
      c.quests.enabled = true
    })
    let questReplies = 0
    autoReply(client, (cmd) => (cmd === 'quests' ? (questReplies++ < 2 ? { content: 'Please wait 30 more seconds' } : { content: 'ok' }) : oneFish))
    const quests = () => names().filter((n) => n === 'quests').length
    await engine.start(A)
    await tick(5_000)
    expect(quests()).toBe(1)
    await tick(25_000) // 30 s + 0.6 s after the reply at 2.5 s → not yet
    expect(quests()).toBe(1)
    await tick(10_000)
    expect(quests()).toBe(2) // ≈ 33.1 s
    // the copy got "wait 30" again: not deferred a second time, the quests slot is re-armed 30 s + 3 min later
    await tick(200_000 - 40_000)
    expect(quests()).toBe(2)
    await tick(60_000)
    expect(quests()).toBe(3)
  })

  it('a fish cooldown with no reply target right after a /fish still reschedules the fish', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    client.emitBot(oneFish) // answers the first /fish
    await tick(FISH_DELAY + 10)
    expect(names()).toEqual(['fish', 'fish'])
    client.emitBot(oneFish) // answers the second: next fish in ≈ 3 s…
    client.emitBot({ ...cooldown(20), isEdit: true }) // …until the reply is edited into a cooldown (no reply target)
    await tick(19_000)
    expect(names()).toEqual(['fish', 'fish'])
    await tick(2_000)
    expect(names()).toEqual(['fish', 'fish', 'fish'])
  })
})

describe('Engine: message edits', () => {
  it('an edited catch with the same (or changed) text is not counted twice', async () => {
    const { client, engine, state } = setup()
    await engine.start(A)
    client.emitBot({ ...CATCH, id: 'x1' })
    expect(state.snapshot().session.catches).toBe(3)
    client.emitBot({ ...CATCH, id: 'x1', isEdit: true })
    expect(state.snapshot().session.catches).toBe(3)
    client.emitBot({ ...oneFish, id: 'x1', isEdit: true }) // changed text, still a catch
    expect(state.snapshot().session.catches).toBe(3)
    expect(state.snapshot().log.filter((l) => l.type === 'catch')).toHaveLength(1)
  })

  it('an edit of an already solved captcha message does not re-enter the captcha', async () => {
    const { client, engine } = setup()
    await engine.start(A)
    client.emitBot({ ...CAPTCHA, id: 'cap1' })
    client.emitBot(SOLVED)
    await tick(15_000)
    expect(engine.state).toBe('running')
    client.emitBot({ ...CAPTCHA, id: 'cap1', isEdit: true }) // same text
    client.emitBot({ ...CAPTCHA, id: 'cap1', isEdit: true, embeds: [{ title: 'Captcha', description: 'Use /verify (expired)', fields: [] }] })
    expect(engine.state).toBe('running')
  })

  it('a captcha arriving as an edit of the /fish reply still enters the captcha', async () => {
    const { client, engine, state } = setup()
    await engine.start(A)
    client.emitBot({ ...oneFish, id: 'f1' })
    client.emitBot({ ...CAPTCHA, id: 'f1', isEdit: true })
    expect(engine.state).toBe('captcha')
    expect(state.snapshot().session.captchas).toBe(1)
  })
})

describe('Engine: leaving a captcha', () => {
  it('a captcha while user-paused goes back to paused (user) once solved, not running', async () => {
    const { client, engine, states, names } = setup()
    await engine.start(A)
    engine.pause()
    client.emitBot(CAPTCHA)
    expect(engine.state).toBe('captcha')
    client.emitBot(SOLVED)
    await tick(15_000)
    expect(engine.state).toBe('paused')
    expect(states.at(-1)?.info?.reason).toBe('user')
    await tick(60_000)
    expect(names()).toEqual(['fish'])
    engine.resume()
    expect(engine.state).toBe('running')
    await tick(FISH_DELAY + 100)
    expect(names()).toEqual(['fish', 'fish'])
  })

  it('network-paused → paused (network) after the captcha; a reconnect during the captcha → running', async () => {
    const a = setup()
    await a.engine.start(A)
    a.client.emitDisconnect()
    a.client.emitBot(CAPTCHA)
    a.client.emitBot(SOLVED)
    await tick(15_000)
    expect(a.engine.state).toBe('paused')
    expect(a.states.at(-1)?.info?.reason).toBe('network')
    a.client.emitReconnect()
    expect(a.engine.state).toBe('running')

    const b = setup()
    await b.engine.start(A)
    b.client.emitBot(CAPTCHA)
    b.client.emitDisconnect()
    b.client.emitReconnect()
    b.client.emitBot(SOLVED)
    await tick(15_000)
    expect(b.engine.state).toBe('running')
  })

  it('the solved answer is reported in the captcha state; verify is refused afterwards', async () => {
    const { client, engine, states, names } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA)
    client.emitBot(SOLVED)
    expect(engine.state).toBe('captcha')
    expect(states.at(-1)?.info).toMatchObject({ captchaSolved: true, captchaText: expect.stringMatching(/solved/) })
    expect(engine.stateInfo.captchaSolved).toBe(true)
    engine.submitCaptcha('again')
    await tick(3_000)
    expect(names()).not.toContain('verify')
  })

  it('stop during a captcha → idle, nothing sent', async () => {
    const { client, engine, names } = setup()
    await engine.start(A)
    client.emitBot(CAPTCHA)
    engine.stop()
    expect(engine.state).toBe('idle')
    await tick(60_000)
    expect(names()).toEqual(['fish'])
  })
})

const PROFILE_REPLY: Partial<BotMessage> = {
  embeds: [
    {
      title: 'Inventory of Player',
      description: 'Balance: $1,000.\nLevel 3, 10/100 XP to next level.\nFish Value: $500',
      fields: []
    }
  ]
}
const QUESTS_REPLY: Partial<BotMessage> = {
  embeds: [{ title: 'Quest List', description: '**Daily Fishing** - 1/5', fields: [] }]
}
const gracefulReply = (cmd: string): Partial<BotMessage> | null =>
  cmd === 'profile' ? PROFILE_REPLY : cmd === 'quests' ? QUESTS_REPLY : cmd === 'fish' ? oneFish : null

describe('Engine: graceful stop', () => {
  it('stops fishing, sends /profile then /quests, ends idle once both answered', async () => {
    const { client, engine, names, state, states } = setup()
    autoReply(client, gracefulReply)
    await engine.start(A)
    await tick(10_000)
    const before = names().length
    expect(names().every((n) => n === 'fish')).toBe(true)

    engine.stop({ graceful: true })
    expect(engine.state).toBe('stopping')
    expect(state.snapshot().nextFishAt).toBeNull()
    await tick(10_000)
    expect(names().slice(before)).toEqual(['profile', 'quests'])
    expect(engine.state).toBe('idle')
    expect(states.at(-1)).toEqual({ s: 'idle', info: {} })
    expect(state.snapshot().account.fishValue).toBe(500)
    expect(state.snapshot().quests).toHaveLength(1)
    expect(client.activeChannel).toBeNull()
    await tick(60_000)
    expect(names().slice(before)).toEqual(['profile', 'quests'])
  })

  it('without answers: no retry, idle within 25 s even behind an unanswered /fish', async () => {
    const { client, engine, names } = setup()
    await engine.start(A) // /fish in flight, never answered: profile at 8 s, quests at 16 s
    engine.stop({ graceful: true })
    await tick(23_000)
    expect(engine.state).toBe('stopping')
    await tick(2_000)
    expect(engine.state).toBe('idle')
    expect(names()).toEqual(['fish', 'profile', 'quests'])
    await tick(60_000)
    expect(client.sent).toHaveLength(3)
  })

  it('the whole graceful stop is capped at 25 s', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'fish' ? oneFish : null))
    await engine.start(A)
    await tick(1_000)
    engine.stop({ graceful: true })
    client.emitRateLimited(60_000) // nothing can leave before the cap
    await tick(24_900)
    expect(engine.state).toBe('stopping')
    await tick(200)
    expect(engine.state).toBe('idle')
    await tick(60_000)
    expect(names()).toEqual(['fish'])
  })

  it('timeouts move on to the next command without retrying it', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'fish' ? oneFish : null))
    await engine.start(A)
    await tick(1_000)
    engine.stop({ graceful: true })
    await tick(2_000 + 8_000 + 2_500)
    expect(names()).toEqual(['fish', 'profile', 'quests'])
    await tick(8_000)
    expect(engine.state).toBe('idle')
    expect(names()).toEqual(['fish', 'profile', 'quests'])
  })

  it('a second stop while stopping halts immediately', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'fish' ? oneFish : null))
    await engine.start(A)
    await tick(1_000)
    engine.stop({ graceful: true })
    expect(engine.state).toBe('stopping')
    engine.stop({ graceful: true })
    expect(engine.state).toBe('idle')
    await tick(30_000)
    expect(names()).toEqual(['fish'])
  })

  it('no command to refresh: halts immediately', async () => {
    const { client, engine } = setup()
    client.commands = client.commands.filter((c) => c.name !== 'profile' && c.name !== 'quests')
    await engine.start(A)
    engine.stop({ graceful: true })
    expect(engine.state).toBe('idle')
  })

  it('the session limit stops gracefully with its reason', async () => {
    const { client, engine, names, states } = setup((c) => {
      c.sessionLimitH = 1
    })
    autoReply(client, gracefulReply)
    await engine.start(A)
    await tick(60 * 60_000 + 15_000)
    expect(states.some((x) => x.s === 'stopping')).toBe(true)
    expect(engine.state).toBe('idle')
    expect(states.at(-1)).toEqual({ s: 'idle', info: { reason: 'Session limit reached' } })
    expect(names().slice(-2)).toEqual(['profile', 'quests'])
  })

  it('captcha during stopping: frozen, only the user verify; after solve the stop resumes and ends idle', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'fish' ? oneFish : null))
    await engine.start(A)
    await tick(1_000)
    engine.stop({ graceful: true })
    await tick(2_000) // profile sent at 2.5 s
    expect(names()).toEqual(['fish', 'profile'])
    client.emitBot(CAPTCHA) // answers the profile with a captcha
    expect(engine.state).toBe('captcha')
    await tick(5 * 60_000) // the 25 s budget is frozen during the captcha
    expect(engine.state).toBe('captcha')
    expect(names()).toEqual(['fish', 'profile'])

    engine.submitCaptcha('ABC')
    await tick(3_000)
    expect(names()).toEqual(['fish', 'profile', 'verify'])
    client.emitBot(SOLVED)
    await tick(10_100) // resume after 10 s (rand 0.5)
    expect(engine.state).toBe('stopping')
    await tick(3_000)
    expect(names().slice(3)).toEqual(['profile']) // the unanswered /profile is sent again
    client.emitBot(PROFILE_REPLY)
    await tick(3_000)
    expect(names().slice(3)).toEqual(['profile', 'quests'])
    client.emitBot(QUESTS_REPLY)
    expect(engine.state).toBe('idle')
    expect(names().filter((n) => n === 'fish')).toHaveLength(1)
  })

  it('« Arrêter la pêche » during a captcha in stopping halts at once', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'fish' ? oneFish : null))
    await engine.start(A)
    await tick(1_000)
    engine.stop({ graceful: true })
    client.emitBot(CAPTCHA)
    expect(engine.state).toBe('captcha')
    engine.stop({ graceful: false })
    expect(engine.state).toBe('idle')
    await tick(60_000)
    expect(names()).toEqual(['fish'])
  })

  it('hard stop (default) stays immediate', async () => {
    const { client, engine, names } = setup()
    autoReply(client, gracefulReply)
    await engine.start(A)
    await tick(5_000)
    const n = names().length
    engine.stop()
    expect(engine.state).toBe('idle')
    await tick(60_000)
    expect(names()).toHaveLength(n)
  })
})

describe('Engine: real captures', () => {
  it('a catch completing a quest refreshes /quests', async () => {
    const { client, engine, names, state } = setup()
    await engine.start(A)
    client.emitBot(realForEngine('catch-levelup-quest'))
    await tick(2_500)
    expect(names()).toEqual(['fish', 'quests'])
    expect(state.snapshot().log.some((l) => l.highlight && l.text === 'Quest completed: Daily Level-ups Tier 3')).toBe(true)
    expect(state.snapshot().session.rareCaught.gold).toBe(6)
  })

  it('"Daily reward on cooldown" in reply to /daily sets nextDailyAt and does not touch fishing', async () => {
    const { client, engine, names, state } = setup((c) => {
      c.daily.enabled = true
    })
    autoReply(client, (cmd) => (cmd === 'daily' ? realForEngine('daily-cooldown') : oneFish))
    const t0 = Date.now()
    await engine.start(A)
    await tick(10_000)
    expect(names().filter((n) => n === 'daily')).toHaveLength(1)
    const wait = ((10 * 60 + 20) * 60 + 25) * 1000
    const next = state.snapshot().nextDailyAt!
    expect(next).toBeGreaterThanOrEqual(t0 + wait)
    expect(next).toBeLessThanOrEqual(t0 + 10_000 + wait)
    expect(engine.state).toBe('running')
    expect(names().filter((n) => n === 'fish').length).toBeGreaterThanOrEqual(2)
  })

  it('another player editing our catch (« no fish to sell ») is never logged nor counted', async () => {
    const { client, engine, state } = setup()
    await engine.start(A)
    client.emitBot(realForEngine('catch-before-edit'))
    const after = state.snapshot()
    expect(after.session.catches).toBe(18)
    client.emitBot(realForEngine('edit-other-player'))
    const now = state.snapshot()
    expect(now.session).toEqual(after.session)
    expect(now.log).toEqual(after.log)
  })

  it('such an edit of a message we never saw is dropped too', async () => {
    const { client, engine, state } = setup()
    await engine.start(A)
    const logLen = state.snapshot().log.length
    client.emitBot(realForEngine('edit-other-player'))
    expect(state.snapshot().log).toHaveLength(logLen)
    expect(engine.state).toBe('running')
  })
})
