import type { BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo } from '../../shared/types'

export const VIRTUAL_FISHER_ID = '574652751745777665'

export type LoginErrorKind = 'invalidToken' | 'network'

/** Login failure: `invalidToken` = Discord rejected the token; `network` = transport/timeout. */
export class LoginError extends Error {
  constructor(readonly kind: LoginErrorKind) {
    super(kind === 'invalidToken' ? 'Invalid or expired token' : 'Unable to connect to Discord')
    this.name = 'LoginError'
  }
}

export type SlashOptions = Record<string, string | number | boolean>

export type DiscordEventMap = {
  botMessage: (m: BotMessage) => void
  disconnected: () => void
  reconnected: () => void
  rateLimited: (retryAfterMs: number) => void
}

export interface DiscordClient {
  /** Rejects if the token is invalid. */
  login(token: string): Promise<SelfUser>
  logout(): Promise<void>
  /** `refresh` drops the cached Virtual Fisher detection and re-checks every server. */
  listGuilds(opts?: { refresh?: boolean }): Promise<GuildInfo[]>
  /** Preloads known detection results (guild id to VF present), e.g. from the previous run. */
  seedVfCache(map: Record<string, boolean>): void
  getVfCache(): Record<string, boolean>
  /** Text channels where we can write and use slash commands. */
  listChannels(guildId: string): Promise<ChannelInfo[]>
  getBotCommands(guildId: string): Promise<SlashCommandInfo[]>
  sendSlash(channelId: string, command: string, options?: SlashOptions): Promise<void>
  /** Only the active channel's bot messages (create + update) are forwarded. */
  setActiveChannel(channelId: string | null): void
  /** Returns an unsubscribe function. */
  on<E extends keyof DiscordEventMap>(event: E, cb: DiscordEventMap[E]): () => void
}
