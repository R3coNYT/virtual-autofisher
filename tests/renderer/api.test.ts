import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (..._args: unknown[]) => undefined)
type Handler = (e: { payload: unknown }) => void
const listeners: { name: string; handler: Handler; unlisten: ReturnType<typeof vi.fn> }[] = []
let resolveListen: (() => void) | null = null

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: Handler) => {
    const unlisten = vi.fn()
    listeners.push({ name, handler, unlisten })
    return new Promise((r) => (resolveListen = () => r(unlisten)))
  }
}))

const { createTauriApi, tauriEventName } = await import('../../src/renderer/api')

beforeEach(() => {
  invoke.mockClear()
  listeners.length = 0
})

describe('Tauri api bridge', () => {
  it('invokes the backend commands with their exact names and camelCase args', async () => {
    const api = createTauriApi()
    await api.auth.setToken('t')
    await api.guilds.list({ refresh: true })
    await api.guilds.list()
    await api.channels.list('10001')
    await api.target.set('10001', '20001')
    await api.engine.stop(false)
    await api.engine.stop()
    await api.command.send('top', { category: 'money' })
    await api.config.update({ sessionLimitH: 2 })
    await api.app.openDataDir()
    expect(invoke.mock.calls).toEqual([
      ['auth_set_token', { token: 't' }],
      ['guilds_list', { refresh: true }],
      ['guilds_list', { refresh: false }],
      ['channels_list', { guildId: '10001' }],
      ['target_set', { guildId: '10001', channelId: '20001' }],
      ['engine_stop', { graceful: false }],
      ['engine_stop', { graceful: null }],
      ['command_send', { name: 'top', options: { category: 'money' } }],
      ['config_update', { patch: { sessionLimitH: 2 } }],
      ['app_open_data_dir']
    ])
  })

  it('listens to the colon event names and delivers payloads (null → undefined)', async () => {
    expect(tauriEventName('engine.state')).toBe('engine:state')
    const api = createTauriApi()
    const got: unknown[] = []
    api.on('captcha.hide', (p) => got.push(p))
    api.on('engine.state', (p) => got.push(p))
    expect(listeners.map((l) => l.name)).toEqual(['captcha:hide', 'engine:state'])
    listeners[0].handler({ payload: null })
    listeners[1].handler({ payload: { state: 'idle', info: {} } })
    expect(got).toEqual([undefined, { state: 'idle', info: {} }])
  })

  it('an unsubscribe called before listen resolves still unlistens', async () => {
    const api = createTauriApi()
    const off = api.on('toast', () => {})
    off()
    resolveListen?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(listeners[0].unlisten).toHaveBeenCalled()
  })
})
