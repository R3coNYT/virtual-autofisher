import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore, type Cipher } from '../../src/main/config/ConfigStore'
import { Engine } from '../../src/main/engine/Engine'
import { GameState } from '../../src/main/engine/GameState'
import { publicConfig, registerHandlers } from '../../src/main/ipc/handlers'
import type { BotMessage, SelfUser } from '../../src/shared/types'
import { FakeDiscordClient } from '../helpers/FakeDiscordClient'

const TOKEN = 'MTExMjIyMzMzNDQ0NTU1NjY2.GabcdE.abcdefghijklmnopqrstuvwxyz0'
const ENC = Buffer.from(TOKEN).toString('base64')
const cipher: Cipher = {
  encrypt: (s) => Buffer.from(s).toString('base64'),
  decrypt: (b) => Buffer.from(b, 'base64').toString('utf8'),
  available: () => true
}
const fixture = (name: string): Partial<BotMessage> => {
  const raw = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/messages', `${name}.json`), 'utf8'))
  delete raw.id
  delete raw.channelId
  return raw
}
const T = { guildId: '10001', channelId: '20001' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-ipc-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const ipc = { handle: (c: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void handlers.set(c, fn) }
  const config = new ConfigStore(dir, cipher, { info() {}, warn() {}, error() {} })
  config.load()
  const client = new FakeDiscordClient()
  const state = new GameState()
  const engine = new Engine({ client, config, state, rand: () => 0.5 })
  const sent: { channel: string; payload: unknown }[] = []
  const setCaptureDir = vi.fn()
  const openPath = vi.fn(async () => '')
  let persistedVf: Record<string, boolean> = { old: true }
  const vfStore = { getVfGuilds: () => ({ ...persistedVf }), setVfGuilds: vi.fn((m: Record<string, boolean>) => void (persistedVf = { ...m })) }
  const api = registerHandlers({
    ipc,
    config,
    client,
    engine,
    state,
    send: (channel, payload) => void sent.push({ channel, payload }),
    sessionsDir: join(dir, 'sessions'),
    dataDir: dir,
    openPath,
    setCaptureDir,
    captureDir: join(dir, 'captures'),
    vfStore
  })
  const call = <T>(c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<T>
  return { config, client, engine, state, sent, call, api, setCaptureDir, openPath, vfStore, getPersistedVf: () => persistedVf }
}

describe('registerHandlers', () => {
  it('auth.setToken stores the token and returns the user', async () => {
    const { call, config } = setup()
    const user = await call<SelfUser>('auth.setToken', TOKEN)
    expect(user.username).toBe('tester')
    expect(config.getToken()).toBe(TOKEN)
  })

  it('auth.setToken failure rejects and stores nothing', async () => {
    const { call, config, client } = setup()
    client.failLogin = true
    await expect(call('auth.setToken', TOKEN)).rejects.toThrow('Invalid or expired token')
    expect(config.getToken()).toBeNull()
  })

  it('config.get and config.update never expose tokenEncrypted', async () => {
    const { call, config } = setup()
    await call('auth.setToken', TOKEN)
    expect(config.get().tokenEncrypted).toBe(ENC)
    expect(await call('config.get')).not.toHaveProperty('tokenEncrypted')
    const updated = await call<Record<string, unknown>>('config.update', { sessionLimitH: 2, tokenEncrypted: 'evil' })
    expect(updated).not.toHaveProperty('tokenEncrypted')
    expect(updated.sessionLimitH).toBe(2)
    expect(config.get().tokenEncrypted).toBe(ENC) // renderer cannot overwrite it
    expect(publicConfig(config.get())).not.toHaveProperty('tokenEncrypted')
  })

  it('no payload sent to the renderer contains the token, over a full scenario', async () => {
    const { call, sent, client, api, config } = setup()
    config.setToken(TOKEN)
    await api.autoLogin()
    client.guilds = [{ id: '10001', name: 'G', iconUrl: null, hasVirtualFisher: true }]
    await call('guilds.list')
    await call('target.set', T.guildId, T.channelId)
    await call('config.update', { capture: true })
    await call('engine.start')
    client.emitBot(fixture('catch-basic'))
    client.emitBot(fixture('captcha-image'))
    client.emitDisconnect()
    client.emitReconnect()
    await call('captcha.submit', 'abc')
    await call('auth.logout')
    expect(sent.length).toBeGreaterThan(5)
    const all = JSON.stringify(sent)
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(ENC)
    expect(all).not.toContain('tokenEncrypted')
  })

  it('seeds the client VF cache from the store after login, and saves it after guilds.list', async () => {
    const { call, client, vfStore, getPersistedVf } = setup()
    await call('auth.setToken', TOKEN)
    expect(client.vfCache).toEqual({ old: true })
    client.guilds = [{ id: '10001', name: 'G', iconUrl: null, hasVirtualFisher: true }]
    await call('guilds.list')
    expect(client.listGuildsCalls.at(-1)).toEqual({ refresh: false })
    expect(vfStore.setVfGuilds).toHaveBeenCalled()
    expect(getPersistedVf()).toEqual({ old: true, '10001': true })
  })

  it('guilds.list({ refresh: true }) clears the persisted map and re-detects', async () => {
    const { call, client, getPersistedVf } = setup()
    await call('auth.setToken', TOKEN)
    client.guilds = [{ id: '10001', name: 'G', iconUrl: null, hasVirtualFisher: false }]
    await call('guilds.list', { refresh: true })
    expect(client.listGuildsCalls.at(-1)).toEqual({ refresh: true })
    expect(getPersistedVf()).toEqual({ '10001': false }) // 'old' is gone
  })

  it('target.set persists the target and restarts a running engine', async () => {
    const { call, config, engine, client } = setup()
    await call('target.set', '10001', '20001')
    expect(config.get().target).toEqual({ guildId: '10001', channelId: '20001' })
    expect(engine.state).toBe('idle') // not running: no start
    await call('engine.start')
    expect(engine.state).toBe('running')
    await call('target.set', '10001', '20002')
    expect(config.get().target).toEqual({ guildId: '10001', channelId: '20002' })
    expect(engine.state).toBe('running')
    expect(client.activeChannel).toBe('20002')
  })

  it('engine.start without a target rejects', async () => {
    const { call } = setup()
    await expect(call('engine.start')).rejects.toThrow('No channel selected')
  })

  it('engine.stop writes the session summary to sessions/<startedAt>.json', async () => {
    const { call, config, client, state } = setup()
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('catch-basic'))
    const startedAt = state.snapshot().session.startedAt
    await call('engine.stop', false)
    const files = readdirSync(join(dir, 'sessions'))
    expect(files).toEqual([`${startedAt}.json`])
    const summary = JSON.parse(readFileSync(join(dir, 'sessions', files[0]), 'utf8'))
    expect(summary.catches).toBe(3)
    expect(summary.endedAt).toBeGreaterThan(0)
  })

  it('engine.stop is graceful by default (stopping → /profile, /quests → idle); false halts at once', async () => {
    const { call, config, client, engine } = setup()
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('catch-basic'))
    await call('engine.stop')
    expect(engine.state).toBe('stopping')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(engine.state).toBe('idle')
    expect(client.sent.map((s) => s.command)).toEqual(['profile', 'profile', 'quests']) // start sends /profile first (data before /fish)

    await call('engine.start')
    await call('engine.stop', false)
    expect(engine.state).toBe('idle')
    await call('engine.start')
    await call('engine.stop', true)
    expect(engine.state).toBe('stopping')
    await call('engine.stop', true) // second click: immediate
    expect(engine.state).toBe('idle')
  })

  it('relays engine.state, engine.commands, game.patch and captcha show/hide', async () => {
    const { call, config, client, sent } = setup()
    config.update({ target: T })
    await call('engine.start')
    const channels = () => sent.map((s) => s.channel)
    expect(channels()).toEqual(expect.arrayContaining(['engine.state', 'engine.commands', 'game.patch']))
    client.emitBot(fixture('captcha-image'))
    const show = sent.find((s) => s.channel === 'captcha.show')
    expect(show?.payload).toMatchObject({ imageUrl: 'https://cdn.example.test/captcha/abc123.png' })
    client.emitBot(fixture('captcha-solved'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(channels()).toContain('captcha.hide')
    expect(sent.some((s) => s.channel === 'game.patch')).toBe(true)
    const logs = sent.filter((s) => s.channel === 'log.append').map((s) => s.payload as unknown[])
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l) => Array.isArray(l) && l.length > 0)).toBe(true)
    for (const s of sent.filter((x) => x.channel === 'game.patch')) expect(s.payload).not.toHaveProperty('newLog')
  })

  it('auto-login: valid token connects; invalid token is cleared and reported', async () => {
    const a = setup()
    a.config.setToken(TOKEN)
    await a.api.autoLogin()
    expect(a.sent.map((s) => s.payload)).toEqual([{ status: 'connecting' }, { status: 'connected' }])
    expect(await a.call('auth.status')).toMatchObject({
      user: { username: 'tester' },
      target: null,
      hasToken: true,
      connection: { status: 'connected' }
    })

    const b = setup()
    b.config.setToken(TOKEN)
    b.client.failLogin = true
    await b.api.autoLogin()
    expect(b.config.getToken()).toBeNull()
    expect(b.sent.at(-1)?.payload).toEqual({ status: 'invalidToken' })
    expect(await b.call('auth.status')).toMatchObject({
      user: null,
      hasToken: false,
      connection: { status: 'invalidToken' }
    })
  })

  it('auth.setToken with a bad token leaves a running session untouched', async () => {
    const { call, config, engine, client, sent } = setup()
    await call('auth.setToken', TOKEN)
    config.update({ target: T })
    await call('engine.start')
    client.failLogin = true
    await expect(call('auth.setToken', 'bad')).rejects.toThrow('Invalid or expired token')
    expect(engine.state).toBe('running')
    expect(config.getToken()).toBe(TOKEN)
    expect(sent.map((s) => s.payload)).toContainEqual({ status: 'connecting' })
    expect(sent.at(-1)?.payload).toEqual({ status: 'connected' })
  })

  it('auto-login network failure keeps the token and retries with backoff', async () => {
    const { api, config, client, sent } = setup()
    config.setToken(TOKEN)
    client.failLogin = true
    client.failLoginKind = 'network'
    await api.autoLogin()
    expect(config.getToken()).toBe(TOKEN)
    expect(sent.at(-1)?.payload).toEqual({ status: 'disconnected', message: 'Unable to connect to Discord' })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(sent.filter((s) => (s.payload as { status: string }).status === 'connecting')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500) // 30 s: attempt 2, still failing
    expect(sent.filter((s) => (s.payload as { status: string }).status === 'connecting')).toHaveLength(2)
    client.failLogin = false
    await vi.advanceTimersByTimeAsync(60_000) // 60 s later: succeeds
    expect(sent.at(-1)?.payload).toEqual({ status: 'connected' })
    expect(config.getToken()).toBe(TOKEN)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sent.filter((s) => (s.payload as { status: string }).status === 'connecting')).toHaveLength(3)
  })

  it('a manual setToken cancels the pending auto-login retry and wins over an in-flight one', async () => {
    const { api, config, client, call, sent } = setup()
    config.setToken(TOKEN)
    client.failLogin = true
    client.failLoginKind = 'network'
    await api.autoLogin() // schedules a retry
    client.failLogin = false
    await call('auth.setToken', TOKEN)
    const connecting = () => sent.filter((s) => (s.payload as { status: string }).status === 'connecting').length
    const n = connecting()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(connecting()).toBe(n) // retry was cancelled

    // in-flight auto-login superseded by setToken
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realLogin = client.login.bind(client)
    let first = true
    client.login = async (t: string) => {
      if (first) {
        first = false
        await gate
        throw new Error('late failure')
      }
      return realLogin(t)
    }
    const auto = api.autoLogin()
    await call('auth.setToken', TOKEN)
    release()
    await auto
    expect(config.getToken()).toBe(TOKEN) // stale failure did not clear the token
    expect(sent.at(-1)?.payload).toEqual({ status: 'connected' })
  })

  it('dispose cancels the retry timer', async () => {
    const { api, config, client, sent } = setup()
    config.setToken(TOKEN)
    client.failLogin = true
    client.failLoginKind = 'network'
    await api.autoLogin()
    const n = sent.length
    api.dispose()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sent.length).toBe(n)
  })

  it('target.set validates ids; config.update cannot set the target', async () => {
    const { call, config } = setup()
    await expect(call('target.set', 'g1', '20001')).rejects.toThrow('Invalid server id')
    await expect(call('target.set', '10001', '')).rejects.toThrow('Invalid channel id')
    await expect(call('channels.list', 'x')).rejects.toThrow('Invalid server id')
    expect(config.get().target).toBeNull()
    await call('config.update', { target: T })
    expect(config.get().target).toBeNull()
  })

  it('target.set while paused stops the engine; during a captcha it is rejected', async () => {
    const { call, config, engine, client } = setup()
    config.update({ target: T })
    await call('engine.start')
    await call('engine.pause')
    expect(engine.state).toBe('paused')
    await call('target.set', '10001', '20002')
    expect(engine.state).toBe('idle')
    expect(config.get().target).toEqual({ guildId: '10001', channelId: '20002' })

    await call('engine.start')
    client.emitBot(fixture('captcha-image'))
    expect(engine.state).toBe('captcha')
    await expect(call('target.set', '10001', '20003')).rejects.toThrow('captcha')
    expect(config.get().target?.channelId).toBe('20002')
  })

  it('auth.logout stops the engine, clears the token and reports disconnected', async () => {
    const { call, config, engine, sent } = setup()
    await call('auth.setToken', TOKEN)
    config.update({ target: T })
    await call('engine.start')
    await call('auth.logout')
    expect(engine.state).toBe('idle')
    expect(config.getToken()).toBeNull()
    expect(sent.at(-1)).toEqual({ channel: 'connection.status', payload: { status: 'disconnected' } })
  })

  it('config.capture toggles the capture directory live; openDataDir opens userData', async () => {
    const { call, setCaptureDir, openPath } = setup()
    expect(setCaptureDir).toHaveBeenLastCalledWith(null)
    await call('config.update', { capture: true })
    expect(setCaptureDir).toHaveBeenLastCalledWith(join(dir, 'captures'))
    await call('config.update', { capture: false })
    expect(setCaptureDir).toHaveBeenLastCalledWith(null)
    await call('app.openDataDir')
    expect(openPath).toHaveBeenCalledWith(dir)
  })

  it('toasts: no response, exception, error and session limit (spec §7)', async () => {
    const toasts = (sent: { channel: string; payload: unknown }[]) =>
      sent.filter((s) => s.channel === 'toast').map((s) => s.payload as { level: string; message: string })

    const a = setup()
    a.config.update({ target: T })
    await a.call('engine.start')
    await vi.advanceTimersByTimeAsync(60_000) // nothing answers: 3 timeouts → paused (noResponse)
    expect(a.engine.state).toBe('paused')
    expect(toasts(a.sent)).toEqual([{ level: 'error', message: 'Virtual Fisher is not responding — fishing paused' }])
    a.config.update({ sessionLimitH: 1 })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(a.engine.state).toBe('idle')
    expect(toasts(a.sent).at(-1)).toEqual({ level: 'info', message: 'Session limit reached — fishing stopped' })

    const b = setup()
    b.config.update({ target: T })
    await b.call('engine.start')
    vi.spyOn(b.state, 'apply').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    b.client.emitBot(fixture('catch-basic'))
    expect(b.engine.state).toBe('paused')
    expect(toasts(b.sent)).toEqual([{ level: 'error', message: 'Unexpected error — fishing paused' }])
    await b.call('engine.resume')
    b.client.emitDisconnect()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(b.engine.state).toBe('error')
    expect(toasts(b.sent).at(-1)).toEqual({ level: 'error', message: 'Error: Connection to Discord lost for more than 2 minutes' })

    // a user pause or a plain stop is not toasted
    const c = setup()
    c.config.update({ target: T })
    await c.call('engine.start')
    await c.call('engine.pause')
    await c.call('engine.stop')
    expect(toasts(c.sent)).toEqual([])
  })

  it('engine.status rebuilds the renderer state (captcha included) after a reload', async () => {
    const { call, config, client } = setup()
    expect(await call('engine.status')).toMatchObject({ state: 'idle', captcha: null, snapshot: { session: { catches: 0 } } })
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('catch-basic'))
    await call('engine.pause')
    expect(await call('engine.status')).toMatchObject({ state: 'paused', info: { reason: 'user' }, captcha: null })
    client.emitBot(fixture('captcha-image'))
    const st = await call<{ state: string; captcha: unknown; snapshot: { session: { catches: number; captchas: number }; log: unknown[] } }>(
      'engine.status'
    )
    expect(st.state).toBe('captcha')
    expect(st.captcha).toEqual({ imageUrl: 'https://cdn.example.test/captcha/abc123.png', text: expect.stringMatching(/captcha/i) })
    expect(st.snapshot.session).toMatchObject({ catches: 3, captchas: 1 })
    expect(st.snapshot.log.length).toBeGreaterThan(0)
    expect(JSON.stringify(st)).not.toContain(TOKEN)
  })

  it('captcha solved → captcha.show with solved: true, then captcha.hide', async () => {
    const { call, config, client, sent } = setup()
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('captcha-image'))
    client.emitBot(fixture('captcha-solved'))
    const shows = sent.filter((s) => s.channel === 'captcha.show').map((s) => s.payload)
    expect(shows.at(-1)).toEqual({
      imageUrl: 'https://cdn.example.test/captcha/abc123.png',
      text: 'Captcha solved — resuming in a few seconds…',
      solved: true
    })
    expect(await call('engine.status')).toMatchObject({ captcha: { solved: true } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sent.map((s) => s.channel)).toContain('captcha.hide')
  })

  it('target.set while idle loads the commands, emits them and listens to the channel; command.send works idle', async () => {
    const { call, client, engine, sent } = setup()
    await call('target.set', T.guildId, T.channelId)
    expect(engine.state).toBe('idle')
    expect(client.activeChannel).toBe(T.channelId)
    const emitted = sent.filter((s) => s.channel === 'engine.commands')
    expect(emitted).toHaveLength(1)
    expect((emitted[0].payload as { name: string }[]).map((c) => c.name)).toContain('profile')

    await call('command.send', 'profile')
    expect(client.sent).toEqual([{ channelId: T.channelId, command: 'profile', options: undefined }])
    client.emitBot(fixture('catch-basic'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(client.sent).toHaveLength(1) // no fishing started
    expect(engine.state).toBe('idle')
  })

  it('commands are loaded and emitted after auto-login and setToken when a target exists', async () => {
    const a = setup()
    a.config.update({ target: T })
    a.config.setToken(TOKEN)
    await a.api.autoLogin()
    expect(a.sent.some((s) => s.channel === 'engine.commands' && (s.payload as unknown[]).length > 0)).toBe(true)
    expect(a.client.activeChannel).toBe(T.channelId)

    const b = setup()
    b.config.update({ target: T })
    await b.call('auth.setToken', TOKEN)
    expect(b.sent.filter((s) => s.channel === 'engine.commands').at(-1)?.payload).not.toEqual([])
    expect(b.client.activeChannel).toBe(T.channelId)
  })

  it('failing to load the commands: toast and an empty list, login still succeeds', async () => {
    const { call, client, sent, config } = setup()
    config.update({ target: T })
    client.failCommands = true
    await call('auth.setToken', TOKEN)
    expect(sent.filter((s) => s.channel === 'engine.commands').at(-1)?.payload).toEqual([])
    expect(sent.some((s) => s.channel === 'toast' && (s.payload as { level: string }).level === 'error')).toBe(true)
    expect(sent.at(-1)?.channel === 'connection.status' || sent.some((s) => (s.payload as { status?: string }).status === 'connected')).toBe(true)
  })

  it('logout stops listening and empties the commands; a plain stop keeps the channel', async () => {
    const { call, client, config, sent } = setup()
    await call('auth.setToken', TOKEN)
    config.update({ target: T })
    await call('engine.start')
    await call('engine.stop', false)
    expect(client.activeChannel).toBe(T.channelId)
    await call('auth.logout')
    expect(client.activeChannel).toBeNull()
    expect(sent.filter((s) => s.channel === 'engine.commands').at(-1)?.payload).toEqual([])
  })

  it('engine.stop during a captcha → idle, captcha.hide, nothing sent', async () => {
    const { call, config, client, engine, sent } = setup()
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('captcha-image'))
    const before = client.sent.length
    await call('engine.stop')
    expect(engine.state).toBe('idle')
    expect(sent.filter((s) => s.channel === 'captcha.hide')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.sent).toHaveLength(before)
    expect(client.sent.map((s) => s.command)).not.toContain('verify')
  })
})
