import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptchaPayload, ConnectionStatus, EngineStatus, EventChannel, EventMap } from '../../shared/ipc'
import type { Config, EngineInfo, EngineState, SelfUser, SessionSummary } from '../../shared/types'
import type { ConfigStore } from '../config/ConfigStore'
import { LoginError, type DiscordClient } from '../discord/DiscordClient'
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
  /** Persists the Virtual Fisher detection per guild (state.json). Never holds the token. */
  vfStore?: { getVfGuilds(): Record<string, boolean>; setVfGuilds(map: Record<string, boolean>): void }
}

/** The only config shape allowed to cross to the renderer: never carries the encrypted token. */
export function publicConfig(c: Config): Config {
  const { tokenEncrypted: _omit, ...rest } = c
  return rest
}

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]
const ID = /^\d{5,25}$/
const assertId = (v: unknown, what: string): void => {
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${what} id`)
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function captchaPayload(info: EngineInfo | undefined): CaptchaPayload {
  const p: CaptchaPayload = { imageUrl: info?.captchaImageUrl, text: info?.captchaText ?? '' }
  if (info?.captchaSolved) p.solved = true
  return p
}

/** Spec §7: the user is told when the engine stops or pauses on its own. */
function stateToast(s: EngineState, prev: EngineState, info: EngineInfo | undefined): EventMap['toast'] | null {
  const reason = info?.reason
  if (s === 'paused' && prev !== 'paused' && reason === 'noResponse') {
    return { level: 'error', message: 'Virtual Fisher is not responding — fishing paused' }
  }
  if (s === 'paused' && prev !== 'paused' && reason === 'exception') {
    return { level: 'error', message: 'Unexpected error — fishing paused' }
  }
  if (s === 'error') return { level: 'error', message: reason ? `Error: ${reason}` : 'Engine error' }
  if (s === 'idle' && reason) return { level: 'info', message: `${reason} — fishing stopped` }
  return null
}

export function registerHandlers(deps: HandlerDeps): { autoLogin(): Promise<void>; dispose(): void; startEngine(): Promise<void> } {
  const { ipc, config, client, engine, state, send, sessionsDir } = deps
  const logger = deps.logger ?? noopLogger
  let user: SelfUser | null = null

  let lastConnection: EventMap['connection.status'] | null = null
  const setConnection = (status: ConnectionStatus, message?: string): void => {
    lastConnection = message ? { status, message } : { status }
    send('connection.status', lastConnection)
  }

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
    if (s === 'captcha') send('captcha.show', captchaPayload(info))
    else if (prev === 'captcha') send('captcha.hide', undefined)
    const toast = stateToast(s, prev, info)
    if (toast) send('toast', toast)
    prev = s
  })
  state.onPatch((patch, newLog) => {
    send('game.patch', patch)
    if (newLog.length) send('log.append', newLog)
  })
  // every (re)load of the command list: session start, target change, login, logout
  engine.onCommands((cmds) => send('engine.commands', cmds))
  client.on('disconnected', () => setConnection('disconnected'))
  client.on('reconnected', () => setConnection('connected'))
  engine.onSessionEnd((s: SessionSummary) => {
    try {
      mkdirSync(sessionsDir, { recursive: true })
      writeFileSync(join(sessionsDir, `${s.startedAt ?? s.endedAt}.json`), JSON.stringify(s, null, 2), 'utf8')
    } catch (e) {
      logger.error('Unable to write the session summary', e)
    }
  })

  const seedVf = (): void => {
    try {
      if (deps.vfStore) client.seedVfCache(deps.vfStore.getVfGuilds())
    } catch (e) {
      logger.warn('Unable to seed the server cache', e)
    }
  }

  /**
   * Manual mode: listen to the target channel and load its commands without a session, so the
   * quick commands work while idle. A failure is toasted (the list is emptied by the engine).
   */
  const loadCommands = async (): Promise<void> => {
    const target = config.get().target
    if (!target) return
    try {
      await engine.useTarget(target)
    } catch (e) {
      logger.warn(`Unable to load the commands: ${maskSecrets(e instanceof Error ? e.message : String(e))}`)
      send('toast', { level: 'error', message: 'Unable to load the Virtual Fisher commands' })
    }
  }

  // --- auth ---------------------------------------------------------------------------------
  handle('auth.setToken', async (token: string) => {
    loginGen++
    cancelRetry()
    setConnection('connecting')
    let me: SelfUser
    try {
      me = await client.login(token) // validate first: a bad token must not touch the running session
    } catch (e) {
      setConnection(user ? 'connected' : 'disconnected')
      throw e
    }
    cancelRetry()
    engine.detach() // possibly another account: forget the channel and its cached commands
    try {
      config.setToken(token)
    } catch (e) {
      await client.logout().catch(() => {})
      throw e
    }
    user = me
    seedVf()
    setConnection('connected')
    await loadCommands()
    return me
  })
  handle('auth.logout', async () => {
    cancelRetry()
    engine.detach() // stops listening to the channel
    await client.logout()
    config.clearToken()
    user = null
    cancelRetry()
    setConnection('disconnected')
  })
  handle('auth.status', () => ({
    user,
    target: config.get().target,
    hasToken: config.getToken() !== null,
    connection: lastConnection
  }))

  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let loginGen = 0 // bumped by every manual setToken: stale auto-login results are ignored
  function cancelRetry(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    attempt = 0
  }

  /** Logs in with the stored token. Auth rejection clears it; network errors keep it and retry with backoff. */
  async function autoLogin(): Promise<void> {
    retryTimer = null
    const token = config.getToken()
    if (!token) return
    const gen = loginGen
    setConnection('connecting')
    try {
      const me = await client.login(token)
      if (gen !== loginGen) return // a manual setToken started meanwhile
      user = me
      seedVf()
      attempt = 0
      setConnection('connected')
      await loadCommands()
    } catch (e) {
      if (gen !== loginGen) return
      user = null
      if (e instanceof LoginError && e.kind === 'network') {
        setConnection('disconnected', e.message)
        const delay = RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)]
        retryTimer = setTimeout(() => void autoLogin().catch((err) => logger.error('auto-login retry failed', err)), delay)
      } else {
        config.clearToken()
        setConnection('invalidToken')
      }
    }
  }

  // --- discord lookups / target -------------------------------------------------------------
  handle('guilds.list', async (opts?: { refresh?: boolean }) => {
    const refresh = opts?.refresh === true
    if (refresh) deps.vfStore?.setVfGuilds({}) // also forgets what a previous run learned
    const list = await client.listGuilds({ refresh })
    try {
      deps.vfStore?.setVfGuilds(client.getVfCache())
    } catch (e) {
      logger.warn('Unable to save the server cache', e)
    }
    return list
  })
  handle('channels.list', (guildId: string) => {
    assertId(guildId, 'server')
    return client.listChannels(guildId)
  })
  handle('target.set', async (guildId: string, channelId: string) => {
    assertId(guildId, 'server')
    assertId(channelId, 'channel')
    if (engine.state === 'captcha') throw new Error('Solve the captcha before changing channel')
    const target = { guildId, channelId }
    const was = engine.state
    config.update({ target })
    if (was === 'running' || was === 'resting') return void (await engine.start(target)) // stops the old session itself
    if (was === 'paused' || was === 'stopping') engine.stop() // resuming would fish in the old channel
    await loadCommands() // idle: listen to the new channel, commands of its guild (emitted)
  })

  // --- engine -------------------------------------------------------------------------------
  const startEngine = async (): Promise<void> => {
    const target = config.get().target
    if (!target) throw new Error('No channel selected')
    await engine.start(target) // emits engine.commands once they are loaded
  }
  handle('engine.start', startEngine)
  handle('engine.pause', () => engine.pause())
  handle('engine.resume', () => engine.resume())
  // graceful unless told otherwise; during a captcha "Stop" always means now
  handle('engine.stop', (graceful?: unknown) =>
    engine.stop({ graceful: graceful !== false && engine.state !== 'captcha' })
  )
  handle('engine.commands', () => engine.availableCommands)
  handle('engine.status', (): EngineStatus => {
    const s = engine.state
    const info = engine.stateInfo
    return { state: s, info, captcha: s === 'captcha' ? captchaPayload(info) : null, snapshot: state.snapshot() }
  })
  handle('command.send', (name: string, options?: Record<string, string | number>) => engine.sendManual(name, options))
  handle('captcha.submit', (answer: string) => engine.submitCaptcha(answer))
  handle('captcha.regen', () => engine.regenCaptcha())

  // --- config / app -------------------------------------------------------------------------
  handle('config.get', () => publicConfig(config.get()))
  handle('config.update', (patch: Partial<Config>) => {
    const { tokenEncrypted: _omit, target: _target, ...safe } = patch // token and target are not writable here (target: target.set)
    return publicConfig(config.update(safe))
  })
  handle('app.openDataDir', async () => {
    await deps.openPath(deps.dataDir)
  })

  return { autoLogin, dispose: cancelRetry, startEngine }
}
