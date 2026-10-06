import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { DEFAULT_CONFIG, type BotMessage, type Config } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'
import { v2ForEngine } from '../helpers/realFixture'

const A = { guildId: 'g1', channelId: 'A' }
const oneFish: Partial<BotMessage> = { embeds: [{ title: 'You caught:', description: 'Cod x1', fields: [] }] }
const boostsWith = (personalSec: number | null): Partial<BotMessage> => ({
  embeds: [
    {
      title: 'Active Boosts',
      description: [
        personalSec !== null ? `Personal Boost: **${personalSec}s**` : '',
        'Global Boost Duration: **3h 24m 35s**',
        'Current Booster: **Messor**'
      ]
        .filter(Boolean)
        .join('\n'),
      fields: []
    }
  ]
})
const USE_REPLY: Partial<BotMessage> = { content: 'Something about your booster' }
const CAPTCHA: Partial<BotMessage> = {
  embeds: [{ title: 'Captcha', description: 'Please complete this captcha: /verify <code>', fields: [], imageUrl: 'https://x/c.png' }]
}

type Reply = (cmd: string, options?: Record<string, unknown>) => Partial<BotMessage> | null

function setup(patch: (c: Config) => void = () => {}) {
  const cfg: Config = structuredClone(DEFAULT_CONFIG)
  cfg.sell.enabled = false
  cfg.daily.enabled = false
  cfg.quests.enabled = false
  cfg.profile.refreshMin = 0
  cfg.boosters.autoPersonal = true
  patch(cfg)
  const client = new FakeDiscordClient()
  client.commands.push(
    { name: 'boosters', id: 'cmd-20', version: 'v20', options: [] },
    {
      name: 'use',
      id: 'cmd-21',
      version: 'v21',
      options: [{ name: 'type', type: 3, required: true, choices: ['personal', 'global'] }]
    }
  )
  const state = new GameState()
  const engine = new Engine({ client, config: { get: () => structuredClone(cfg) }, state, rand: () => 0.5 })
  const names = () => client.sent.map((s) => s.command)
  const count = (n: string) => names().filter((x) => x === n).length
  return { cfg, client, state, engine, names, count }
}

/** The fake bot answers each command right after it is sent. */
function autoReply(client: FakeDiscordClient, reply: Reply) {
  const orig = client.sendSlash.bind(client)
  client.sendSlash = async (channelId, command, options) => {
    await orig(channelId, command, options)
    queueMicrotask(() => {
      const r = reply(command, options)
      if (r) client.emitBot(r)
    })
  }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('/boosts at session start', () => {
  it('is sent first at every start, even with buffs disabled, and fills the boost chips', async () => {
    const { client, engine, state, names } = setup((c) => {
      c.buffs.enabled = false
      c.boosters.autoPersonal = false
    })
    autoReply(client, (cmd) => (cmd === 'boosts' ? v2ForEngine('boosts-active') : oneFish))
    const t0 = Date.now()
    await engine.start(A)
    expect(names()).toEqual(['boosts'])
    await tick(3_000)
    expect(names().slice(0, 2)).toEqual(['boosts', 'fish'])
    expect(state.snapshot().boosts).toEqual([
      { name: 'Personal', endsAt: t0 + (9 * 60 + 43) * 1000 },
      { name: 'Global', endsAt: t0 + ((3 * 60 + 24) * 60 + 35) * 1000, by: 'Messor' }
    ])
  })

  it('/profile goes before /fish at start', async () => {
    const { client, engine, names } = setup((c) => {
      c.profile.refreshMin = 5
      c.boosters.autoPersonal = false
    })
    client.commands = client.commands.filter((c) => c.name !== 'boosts')
    await engine.start(A)
    expect(names()).toEqual(['profile'])
  })

  it('a boost that expires during the session re-asks /boosts once', async () => {
    const { client, engine, count } = setup((c) => {
      c.boosters.autoPersonal = false
    })
    let replies = 0
    // first reply: personal boost for 60 s; later replies: only the long global boost
    autoReply(client, (cmd) => (cmd === 'boosts' ? boostsWith(replies++ === 0 ? 60 : null) : oneFish))
    await engine.start(A)
    await tick(55_000)
    expect(count('boosts')).toBe(1)
    await tick(20_000) // 60 s + 2–10 s grace
    expect(count('boosts')).toBe(2)
    await tick(30 * 60_000) // the global boost lasts 3 h: no more /boosts meanwhile
    expect(count('boosts')).toBe(2)
  })
})

describe('auto personal booster (opt-in)', () => {
  it('no personal boost → /boosters → /use type=personal → /use reply logged → /boosts', async () => {
    const { client, engine, state, names, count } = setup()
    let used = false
    autoReply(client, (cmd) => {
      if (cmd === 'boosts') return used ? boostsWith(600) : v2ForEngine('boosts-global-only')
      if (cmd === 'boosters') return v2ForEngine('boosters-one')
      if (cmd === 'use') {
        used = true
        return USE_REPLY
      }
      return oneFish
    })
    await engine.start(A)
    await tick(20_000)
    expect(names().filter((n) => n !== 'fish')).toEqual(['boosts', 'boosters', 'use', 'boosts'])
    expect(client.sent.find((s) => s.command === 'use')?.options).toEqual({ type: 'personal' })
    expect(state.snapshot().account.personalBoosters).toBe(1)
    expect(state.snapshot().log.some((l) => l.type === 'system' && l.text.startsWith('/use: '))).toBe(true)
    expect(state.snapshot().boosts.map((b) => b.name)).toEqual(['Personal', 'Global'])
    expect(count('use')).toBe(1)
  })

  it('never loops: a /use that does not activate anything is not retried', async () => {
    const { client, engine, count } = setup()
    autoReply(client, (cmd) => {
      if (cmd === 'boosts') return v2ForEngine('boosts-global-only') // the /use did nothing
      if (cmd === 'boosters') return v2ForEngine('boosters-one')
      if (cmd === 'use') return USE_REPLY
      return oneFish
    })
    await engine.start(A)
    await tick(60 * 60_000)
    expect(count('boosters')).toBe(1)
    expect(count('use')).toBe(1)
    engine.sendManual('boosters') // a manual /boosters (still owns 1) does not trigger a second /use
    await tick(60_000)
    expect(count('boosters')).toBe(2)
    expect(count('use')).toBe(1)
  })

  it('"You have no boosters" → no /use and no more checks this session', async () => {
    const { client, engine, state, count } = setup()
    let n = 0
    autoReply(client, (cmd) => {
      // personal boost 30 s on the second /boosts (e.g. activated by hand), then it expires
      if (cmd === 'boosts') return boostsWith(n++ === 1 ? 30 : null)
      if (cmd === 'boosters') return v2ForEngine('boosters-none')
      return oneFish
    })
    await engine.start(A)
    await tick(10_000)
    expect(count('boosters')).toBe(1)
    expect(state.snapshot().account.personalBoosters).toBe(0)
    engine.sendManual('boosts') // shows the hand-activated boost
    await tick(5 * 60_000) // it expires: /boosts again, but /boosters said 0 → no new check
    expect(count('boosts')).toBeGreaterThanOrEqual(3)
    expect(count('boosters')).toBe(1)
    expect(count('use')).toBe(0)
  })

  it('personal boost expiring mid-session → one new check and one /use per expiry', async () => {
    const { client, engine, count } = setup()
    let active = false
    autoReply(client, (cmd) => {
      if (cmd === 'boosts') {
        const r = boostsWith(active ? 120 : null)
        active = false // the boost seen once, it expires 2 min later
        return r
      }
      if (cmd === 'boosters') return v2ForEngine('boosters-one')
      if (cmd === 'use') {
        active = true
        return USE_REPLY
      }
      return oneFish
    })
    await engine.start(A)
    await tick(30_000)
    expect(count('use')).toBe(1)
    await tick(3 * 60_000) // expiry → /boosts → no personal → /boosters → /use
    expect(count('use')).toBe(2)
    expect(count('boosters')).toBe(2)
  })

  it('disabled → never /boosters nor /use', async () => {
    const { client, engine, count } = setup((c) => {
      c.boosters.autoPersonal = false
    })
    autoReply(client, (cmd) => (cmd === 'boosts' ? v2ForEngine('boosts-none') : oneFish))
    await engine.start(A)
    await tick(10 * 60_000)
    expect(count('boosters')).toBe(0)
    expect(count('use')).toBe(0)
  })

  it('no matching /use choice → no /use', async () => {
    const { client, engine, count } = setup()
    client.commands = client.commands.map((c) =>
      c.name === 'use' ? { ...c, options: [{ name: 'type', type: 3, required: true, choices: ['global'] }] } : c
    )
    autoReply(client, (cmd) =>
      cmd === 'boosts' ? v2ForEngine('boosts-none') : cmd === 'boosters' ? v2ForEngine('boosters-one') : oneFish
    )
    await engine.start(A)
    await tick(5 * 60_000)
    expect(count('boosters')).toBe(1)
    expect(count('use')).toBe(0)
  })

  it('captcha: nothing but a user /verify is sent, the booster flow waits', async () => {
    const { client, engine, names } = setup()
    autoReply(client, (cmd) => (cmd === 'boosts' ? CAPTCHA : null))
    await engine.start(A)
    await tick(0)
    expect(engine.state).toBe('captcha')
    const n = client.sent.length
    await tick(30 * 60_000)
    expect(client.sent).toHaveLength(n)
    expect(names()).not.toContain('use')
    expect(names()).not.toContain('verify')
  })
})
