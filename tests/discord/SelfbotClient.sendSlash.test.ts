import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SelfbotClient } from '../../src/main/discord/SelfbotClient'

const VF = '574652751745777665'

function fakeLib(sendSlash: (...a: unknown[]) => Promise<unknown>) {
  const e = new EventEmitter() as EventEmitter & Record<string, unknown>
  e.user = { id: 'u1', username: 'n', displayAvatarURL: () => '' }
  e.guilds = { cache: new Map() }
  e.channels = { cache: new Map([['c1', { isText: () => true, guildId: 'g1', sendSlash }]]) }
  e.api = {
    guilds: {
      g1: {
        'application-command-index': {
          get: async () => ({ application_commands: [{ id: '1', name: 'fish', version: 'v', application_id: VF }], applications: [] })
        }
      }
    }
  }
  e.destroy = vi.fn()
  e.login = async () => {
    queueMicrotask(() => e.emit('ready'))
    return 't'
  }
  return e
}

const connected = async (sendSlash: (...a: unknown[]) => Promise<unknown>) => {
  const c = new SelfbotClient({ createClient: () => fakeLib(sendSlash) as never })
  await c.login('t')
  return c
}

describe('SelfbotClient.sendSlash', () => {
  it("swallows the library's 5 s INTERACTION_FAILED (our own timeout decides) and records the command", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('No responsed from Application'), { code: 'INTERACTION_FAILED' })
    })
    const c = await connected(send)
    await expect(c.sendSlash('c1', 'fish')).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledWith(VF, 'fish')
    expect(c.lastSlash?.command).toBe('fish')
  })

  it('still rejects any other error', async () => {
    const c = await connected(async () => {
      throw Object.assign(new Error('Missing Access'), { code: 50001 })
    })
    await expect(c.sendSlash('c1', 'fish')).rejects.toThrow('Missing Access')
  })
})
