import type {
  ChannelInfo,
  Config,
  DeepPartial,
  EngineState,
  GameSnapshot,
  GuildInfo,
  LogEntry,
  SelfUser,
  SlashCommandInfo
} from './types'

/** Événements main → renderer : nom du canal → type de la charge utile. */
export type EventMap = {
  'engine.state': { state: EngineState; info?: { reason?: string; captchaImageUrl?: string; captchaText?: string } }
  'engine.commands': SlashCommandInfo[]
  /**
   * `patch` is a partial snapshot. The renderer must REPLACE (not deep-merge) the nested section
   * values it contains (fishBySpecies, totals, rare, boosts, quests, ...): a key missing from a
   * replaced section means it was removed. Log entries are NOT part of this payload: see 'log.append'.
   */
  'game.patch': DeepPartial<GameSnapshot>
  /** Log entries appended since the last event (single path for the log). */
  'log.append': LogEntry[]
  'captcha.show': { imageUrl?: string; text: string }
  'captcha.hide': undefined
  'connection.status': { status: ConnectionStatus; message?: string }
  toast: { level: 'info' | 'success' | 'error'; message: string }
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'invalidToken'

export type EventChannel = keyof EventMap

/** API exposée au renderer par le preload (window.api). */
export type Api = {
  auth: {
    setToken(token: string): Promise<SelfUser>
    logout(): Promise<void>
    /** Connection state at launch, to pick the first screen. */
    status(): Promise<{ user: SelfUser | null; target: { guildId: string; channelId: string } | null }>
  }
  guilds: { list(): Promise<GuildInfo[]> }
  channels: { list(guildId: string): Promise<ChannelInfo[]> }
  target: { set(guildId: string, channelId: string): Promise<void> }
  engine: {
    start(): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    stop(): Promise<void>
    commands(): Promise<SlashCommandInfo[]>
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
