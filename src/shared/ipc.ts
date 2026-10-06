import type {
  ChannelInfo,
  Config,
  DeepPartial,
  EngineState,
  GameSnapshot,
  GuildInfo,
  LogEntry,
  PauseReason,
  SelfUser,
  SlashCommandInfo
} from './types'

/** Événements main → renderer : nom du canal → type de la charge utile. */
export type EventMap = {
  'engine.state': { state: EngineState; reason?: PauseReason; message?: string }
  'engine.commands': SlashCommandInfo[]
  'game.patch': DeepPartial<GameSnapshot>
  'log.append': LogEntry
  'captcha.show': { imageUrl?: string; text: string }
  'captcha.hide': undefined
  'connection.status': { connected: boolean }
  toast: { level: 'info' | 'success' | 'error'; message: string }
}

export type EventChannel = keyof EventMap

/** API exposée au renderer par le preload (window.api). */
export type Api = {
  auth: {
    setToken(token: string): Promise<SelfUser>
    logout(): Promise<void>
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
  command: { send(name: string, options?: Record<string, string | number | boolean>): Promise<void> }
  captcha: {
    submit(answer: string): Promise<void>
    regen(): Promise<void>
  }
  config: {
    get(): Promise<Config>
    update(patch: DeepPartial<Config>): Promise<Config>
  }
  on<C extends EventChannel>(channel: C, cb: (payload: EventMap[C]) => void): () => void
}
