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
const T = { guildId: 'g1', channelId: 'c1' }

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
    captureDir: join(dir, 'captures')
  })
  const call = <T>(c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<T>
  return { config, client, engine, state, sent, call, api, setCaptureDir, openPath }
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
    await expect(call('auth.setToken', TOKEN)).rejects.toThrow('Token invalide')
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
    client.guilds = [{ id: 'g1', name: 'G', iconUrl: null, hasVirtualFisher: true }]
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

  it('target.set persists the target and restarts a running engine', async () => {
    const { call, config, engine, client } = setup()
    await call('target.set', 'g1', 'A')
    expect(config.get().target).toEqual({ guildId: 'g1', channelId: 'A' })
    expect(engine.state).toBe('idle') // not running: no start
    await call('engine.start')
    expect(engine.state).toBe('running')
    await call('target.set', 'g1', 'B')
    expect(config.get().target).toEqual({ guildId: 'g1', channelId: 'B' })
    expect(engine.state).toBe('running')
    expect(client.activeChannel).toBe('B')
  })

  it('engine.start without a target rejects', async () => {
    const { call } = setup()
    await expect(call('engine.start')).rejects.toThrow('Aucun salon')
  })

  it('engine.stop writes the session summary to sessions/<startedAt>.json', async () => {
    const { call, config, client, state } = setup()
    config.update({ target: T })
    await call('engine.start')
    client.emitBot(fixture('catch-basic'))
    const startedAt = state.snapshot().session.startedAt
    await call('engine.stop')
    const files = readdirSync(join(dir, 'sessions'))
    expect(files).toEqual([`${startedAt}.json`])
    const summary = JSON.parse(readFileSync(join(dir, 'sessions', files[0]), 'utf8'))
    expect(summary.catches).toBe(3)
    expect(summary.endedAt).toBeGreaterThan(0)
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
    const patch = sent.find((s) => s.channel === 'game.patch')?.payload as { patch: unknown; newLog: unknown[] }
    expect(patch).toHaveProperty('patch')
    expect(Array.isArray(patch.newLog)).toBe(true)
  })

  it('auto-login: valid token connects; invalid token is cleared and reported', async () => {
    const a = setup()
    a.config.setToken(TOKEN)
    await a.api.autoLogin()
    expect(a.sent.map((s) => s.payload)).toEqual([{ status: 'connecting' }, { status: 'connected' }])
    expect(await a.call('auth.status')).toMatchObject({ user: { username: 'tester' }, target: null })

    const b = setup()
    b.config.setToken(TOKEN)
    b.client.failLogin = true
    await b.api.autoLogin()
    expect(b.config.getToken()).toBeNull()
    expect(b.sent.at(-1)?.payload).toEqual({ status: 'invalidToken' })
    expect(await b.call('auth.status')).toMatchObject({ user: null })
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
})
