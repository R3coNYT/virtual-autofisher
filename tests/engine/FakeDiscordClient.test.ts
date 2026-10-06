import { describe, it, expect, vi } from 'vitest'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

describe('FakeDiscordClient', () => {
  it('records sendSlash calls', async () => {
    const f = new FakeDiscordClient()
    await f.sendSlash('c1', 'sell', { amount: 'all' })
    expect(f.sent).toEqual([{ channelId: 'c1', command: 'sell', options: { amount: 'all' } }])
  })

  it('delivers emitBot to subscribers with defaults filled', () => {
    const f = new FakeDiscordClient()
    f.setActiveChannel('c9')
    const cb = vi.fn()
    f.on('botMessage', cb)
    f.emitBot({ content: 'hi' })
    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0][0]).toMatchObject({
      channelId: 'c9', content: 'hi', embeds: [], ephemeral: false, isEdit: false, interactionUserId: 'me'
    })
  })

  it('does not deliver for another channel', () => {
    const f = new FakeDiscordClient()
    f.setActiveChannel('c1')
    const cb = vi.fn()
    f.on('botMessage', cb)
    f.emitBot({ channelId: 'other' })
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribe stops delivery', () => {
    const f = new FakeDiscordClient()
    f.setActiveChannel('c1')
    const cb = vi.fn()
    const off = f.on('botMessage', cb)
    off()
    f.emitBot({})
    expect(cb).not.toHaveBeenCalled()
  })

  it('emits disconnect, reconnect and rateLimited', () => {
    const f = new FakeDiscordClient()
    const d = vi.fn(), r = vi.fn(), l = vi.fn()
    f.on('disconnected', d)
    f.on('reconnected', r)
    f.on('rateLimited', l)
    f.emitDisconnect(); f.emitReconnect(); f.emitRateLimited(1500)
    expect(d).toHaveBeenCalledOnce()
    expect(r).toHaveBeenCalledOnce()
    expect(l).toHaveBeenCalledWith(1500)
  })

  it('failSend rejects and records nothing', async () => {
    const f = new FakeDiscordClient()
    f.failSend = true
    await expect(f.sendSlash('c1', 'fish')).rejects.toThrow()
    expect(f.sent).toEqual([])
  })

  it('login resolves self user, rejects with failLogin', async () => {
    const f = new FakeDiscordClient()
    await expect(f.login('t')).resolves.toEqual({ id: 'me', username: 'tester', avatarUrl: '' })
    f.failLogin = true
    await expect(f.login('t')).rejects.toThrow('Invalid or expired token')
  })
})
