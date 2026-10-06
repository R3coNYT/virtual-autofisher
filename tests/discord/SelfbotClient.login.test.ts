import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SelfbotClient } from '../../src/main/discord/SelfbotClient'

type Fake = EventEmitter & { guilds: { cache: Map<string, unknown> }; user: unknown; login: (t: string) => Promise<string>; destroy: () => void }

function fakeLib(opts: { reject?: Error; id?: string } = {}): Fake {
  const e = new EventEmitter() as Fake
  e.user = { id: opts.id ?? 'u1', username: 'n', displayAvatarURL: () => '' }
  e.guilds = { cache: new Map() }
  e.destroy = vi.fn()
  e.login = async () => {
    if (opts.reject) throw opts.reject
    queueMicrotask(() => e.emit('ready'))
    return 't'
  }
  return e
}

const make = (...libs: Fake[]) => {
  const q = [...libs]
  return new SelfbotClient({ createClient: () => q.shift() as never })
}

describe('SelfbotClient.login swap', () => {
  it('a failed login leaves the current client connected and intact', async () => {
    const a = fakeLib({ id: 'a' })
    const bad = fakeLib({ reject: Object.assign(new Error('x'), { code: 'TOKEN_INVALID' }) })
    const c = make(a, bad)
    await c.login('t1')
    await expect(c.login('bad')).rejects.toMatchObject({ kind: 'invalidToken' })
    expect(a.destroy).not.toHaveBeenCalled()
    expect(bad.destroy).toHaveBeenCalled()
    await expect(c.listGuilds()).resolves.toEqual([]) // still "connected"
  })

  it('a successful login swaps clients, destroys the old one and ignores its events', async () => {
    const a = fakeLib({ id: 'a' })
    const b = fakeLib({ id: 'b' })
    const c = make(a, b)
    const disc = vi.fn()
    c.on('disconnected', disc)
    await c.login('t1')
    const me = await c.login('t2')
    expect(me.id).toBe('b')
    expect(a.destroy).toHaveBeenCalled()
    a.emit('shardDisconnect') // listeners were removed with the old client
    expect(disc).not.toHaveBeenCalled()
    b.emit('shardDisconnect')
    expect(disc).toHaveBeenCalledTimes(1)
  })

  it('events of a not-yet-adopted client are ignored', async () => {
    const a = fakeLib({ id: 'a' })
    const b = fakeLib({ id: 'b' })
    const c = make(a, b)
    const disc = vi.fn()
    c.on('disconnected', disc)
    await c.login('t1')
    const p = c.login('t2')
    b.emit('shardDisconnect') // during login of the new client
    await p
    expect(disc).not.toHaveBeenCalled()
  })
})
