import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionStatus, EventChannel, EventMap } from '../../shared/ipc'
import type { Config, EngineState, SelfUser, SessionSummary } from '../../shared/types'
import type { ConfigStore } from '../config/ConfigStore'
import type { DiscordClient } from '../discord/DiscordClient'
import type { Engine } from '../engine/Engine'
import type { GameState } from '../engine/GameState'
import type { Logger } from '../util/logger'
import { maskSecrets } from '../util/maskSecrets'

export type IpcMainLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, fn: (event: unknown, ...args: any[]) => unknown): void
}

export type HandlerDeps = {
  ipc: IpcMainLike
  config: ConfigStore
  client: DiscordClient
  engine: Engine
  state: GameState
  send: <C extends EventChannel>(channel: C, payload: EventMap[C]) => void
  /** Where session summaries are written (<userData>/sessions). */
  sessionsDir: string
  /** The user data directory, opened by app.openDataDir. */
  dataDir: string
  openPath: (path: string) => Promise<unknown>
  /** Raw message capture: called with the directory when config.capture is on, null when off. */
  setCaptureDir?: (dir: string | null) => void
  captureDir?: string
  logger?: Logger
}

/** The only config shape allowed to cross to the renderer: never carries the encrypted token. */
export function publicConfig(c: Config): Config {
  const { tokenEncrypted: _omit, ...rest } = c
  return rest
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export function registerHandlers(deps: HandlerDeps): { autoLogin(): Promise<void> } {
  const { ipc, config, client, engine, state, send, sessionsDir } = deps
  const logger = deps.logger ?? noopLogger
  let user: SelfUser | null = null

  const setConnection = (status: ConnectionStatus, message?: string): void =>
    send('connection.status', message ? { status, message } : { status })

  const handle = (channel: string, fn: (...args: any[]) => unknown): void => // eslint-disable-line @typescript-eslint/no-explicit-any
    ipc.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args)
      } catch (e) {
        const msg = maskSecrets(e instanceof Error ? e.message : String(e))
        logger.warn(`ipc ${channel} failed: ${msg}`)
        throw new Error(msg)
      }
    })

  const applyCapture = (c: Config): void => {
    deps.setCaptureDir?.(c.capture && deps.captureDir ? deps.captureDir : null)
  }
  applyCapture(config.get())
  config.onChange(applyCapture)

  // --- main → renderer relays -------------------------------------------------------------
  let prev: EngineState = engine.state
  engine.onState((s, info) => {
    send('engine.state', info ? { state: s, info } : { state: s })
    if (s === 'captcha') send('captcha.show', { imageUrl: info?.captchaImageUrl, text: info?.captchaText ?? '' })
    else if (prev === 'captcha') send('captcha.hide', undefined)
    prev = s
  })
  state.onPatch((patch, newLog) => send('game.patch', { patch, newLog }))
  client.on('disconnected', () => setConnection('disconnected'))
  client.on('reconnected', () => setConnection('connected'))
  engine.onSessionEnd((s: SessionSummary) => {
    try {
      mkdirSync(sessionsDir, { recursive: true })
      writeFileSync(join(sessionsDir, `${s.startedAt ?? s.endedAt}.json`), JSON.stringify(s, null, 2), 'utf8')
    } catch (e) {
      logger.error('Écriture du résumé de session impossible', e)
    }
  })

  // --- auth ---------------------------------------------------------------------------------
  handle('auth.setToken', async (token: string) => {
    engine.stop()
    const me = await client.login(token)
    try {
      config.setToken(token)
    } catch (e) {
      await client.logout().catch(() => {})
      throw e
    }
    user = me
    setConnection('connected')
    return me
  })
  handle('auth.logout', async () => {
    engine.stop()
    await client.logout()
    config.clearToken()
    user = null
    setConnection('disconnected')
  })
  handle('auth.status', () => ({ user, target: config.get().target }))

  async function autoLogin(): Promise<void> {
    const token = config.getToken()
    if (!token) return
    setConnection('connecting')
    try {
      user = await client.login(token)
      setConnection('connected')
    } catch {
      config.clearToken()
      user = null
      setConnection('invalidToken')
    }
  }

  // --- discord lookups / target -------------------------------------------------------------
  handle('guilds.list', () => client.listGuilds())
  handle('channels.list', (guildId: string) => client.listChannels(guildId))
  handle('target.set', async (guildId: string, channelId: string) => {
    if (engine.state === 'captcha') throw new Error('Résolvez le captcha avant de changer de salon')
    const target = { guildId, channelId }
    const was = engine.state
    config.update({ target })
    if (was === 'running' || was === 'resting') await engine.start(target) // stops the old session itself
    else if (was === 'paused') engine.stop() // resuming would fish in the old channel
    if (engine.availableCommands.length) send('engine.commands', engine.availableCommands)
  })

  // --- engine -------------------------------------------------------------------------------
  handle('engine.start', async () => {
    const target = config.get().target
    if (!target) throw new Error('Aucun salon sélectionné')
    await engine.start(target)
    send('engine.commands', engine.availableCommands)
  })
  handle('engine.pause', () => engine.pause())
  handle('engine.resume', () => engine.resume())
  handle('engine.stop', () => engine.stop())
  handle('engine.commands', () => engine.availableCommands)
  handle('command.send', (name: string, options?: Record<string, string | number>) => engine.sendManual(name, options))
  handle('captcha.submit', (answer: string) => engine.submitCaptcha(answer))
  handle('captcha.regen', () => engine.regenCaptcha())

  // --- config / app -------------------------------------------------------------------------
  handle('config.get', () => publicConfig(config.get()))
  handle('config.update', (patch: Partial<Config>) => {
    const { tokenEncrypted: _omit, ...safe } = patch // the renderer can never write the token
    return publicConfig(config.update(safe))
  })
  handle('app.openDataDir', async () => {
    await deps.openPath(deps.dataDir)
  })

  return { autoLogin }
}
