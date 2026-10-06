import type {
  ChannelInfo,
  Config,
  DeepPartial,
  EngineInfo,
  EngineState,
  GameSnapshot,
  GuildInfo,
  LogEntry,
  SelfUser,
  SlashCommandInfo
} from './types'

/** Main → renderer events: channel name → payload type. */
export type EventMap = {
  'engine.state': { state: EngineState; info?: EngineInfo }
  'engine.commands': SlashCommandInfo[]
  /**
   * `patch` is a partial snapshot. The renderer must REPLACE (not deep-merge) the nested section
   * values it contains (fishBySpecies, totals, rare, boosts, quests, ...): a key missing from a
   * replaced section means it was removed. Log entries are NOT part of this payload: see 'log.append'.
   */
  'game.patch': DeepPartial<GameSnapshot>
  /** Log entries appended since the last event (single path for the log). */
  'log.append': LogEntry[]
  /** `solved`: the answer was accepted, the panel shows a success state until captcha.hide. */
  'captcha.show': CaptchaPayload
  'captcha.hide': undefined
  'connection.status': { status: ConnectionStatus; message?: string }
  toast: { level: 'info' | 'success' | 'error'; message: string }
}

export type CaptchaPayload = { imageUrl?: string; text: string; solved?: boolean }

/** Everything the renderer needs to rebuild its state after a reload. */
export type EngineStatus = {
  state: EngineState
  info: EngineInfo
  /** Non-null while the engine is in captcha. */
  captcha: CaptchaPayload | null
  snapshot: GameSnapshot
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'invalidToken'

export type AuthStatus = {
  user: SelfUser | null
  target: { guildId: string; channelId: string } | null
  /** A stored token exists (auto-login is, or will be, attempted). */
  hasToken: boolean
  /** Last connection status emitted by main (buffered, so a late renderer still sees it). */
  connection: EventMap['connection.status'] | null
}

export type EventChannel = keyof EventMap

/** API exposed to the renderer by the preload (window.api). */
export type Api = {
  auth: {
    setToken(token: string): Promise<SelfUser>
    logout(): Promise<void>
    /** Connection state at launch, to pick the first screen. */
    status(): Promise<AuthStatus>
  }
  /** `refresh`: forget which servers have Virtual Fisher and check them all again. */
  guilds: { list(opts?: { refresh?: boolean }): Promise<GuildInfo[]> }
  channels: { list(guildId: string): Promise<ChannelInfo[]> }
  target: { set(guildId: string, channelId: string): Promise<void> }
  engine: {
    start(): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    /**
     * Graceful by default (fishing stops, /profile and /quests refresh the data, then idle);
     * `false` halts at once. A stop while already stopping, or during a captcha, always halts at once.
     */
    stop(graceful?: boolean): Promise<void>
    commands(): Promise<SlashCommandInfo[]>
    /** Current state, captcha and game snapshot (renderer reload). */
    status(): Promise<EngineStatus>
  }
  command: { send(name: string, options?: Record<string, string | number>): Promise<void> }
  captcha: {
    submit(answer: string): Promise<void>
    regen(): Promise<void>
  }
  config: {
    get(): Promise<Config>
    update(patch: DeepPartial<Config>): Promise<Config>
  }
  app: { openDataDir(): Promise<void> }
  on<C extends EventChannel>(channel: C, cb: (payload: EventMap[C]) => void): () => void
}
