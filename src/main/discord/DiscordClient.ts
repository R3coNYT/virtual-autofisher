import type { BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo } from '../../shared/types'

export const VIRTUAL_FISHER_ID = '574652751745777665'

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
  listGuilds(): Promise<GuildInfo[]>
  /** Text channels where we can write and use slash commands. */
  listChannels(guildId: string): Promise<ChannelInfo[]>
  getBotCommands(guildId: string): Promise<SlashCommandInfo[]>
  sendSlash(channelId: string, command: string, options?: SlashOptions): Promise<void>
  /** Only the active channel's bot messages (create + update) are forwarded. */
  setActiveChannel(channelId: string | null): void
  /** Returns an unsubscribe function. */
  on<E extends keyof DiscordEventMap>(event: E, cb: DiscordEventMap[E]): () => void
}
