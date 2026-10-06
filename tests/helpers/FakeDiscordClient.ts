import type { BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo } from '../../src/shared/types'
import { LoginError, type DiscordClient, type DiscordEventMap, type LoginErrorKind, type SlashOptions } from '../../src/main/discord/DiscordClient'

const cmd = (name: string, i: number, options: string[] = []): SlashCommandInfo => ({
  name,
  id: `cmd-${i}`,
  version: `ver-${i}`,
  options: options.map((o) => ({ name: o, type: 3, required: false }))
})

export const defaultFakeCommands = (): SlashCommandInfo[] => [
  cmd('fish', 1),
  cmd('sell', 2, ['amount']),
  cmd('buy', 3, ['item', 'amount']),
  cmd('verify', 4, ['answer']),
  cmd('profile', 5),
  cmd('daily', 6),
  cmd('quests', 7),
  cmd('boosts', 8)
]

type Listeners = { [E in keyof DiscordEventMap]: Set<DiscordEventMap[E]> }

export class FakeDiscordClient implements DiscordClient {
  static readonly SELF_ID = 'me'

  sent: { channelId: string; command: string; options?: SlashOptions }[] = []
  commands: SlashCommandInfo[] = defaultFakeCommands()
  guilds: GuildInfo[] = []
  channels: Record<string, ChannelInfo[]> = {}
  failLogin?: boolean
  failLoginKind: LoginErrorKind = 'invalidToken'
  failSend?: boolean
  /** getBotCommands rejects while true. */
  failCommands?: boolean
  /** Guild ids passed to getBotCommands, in call order. */
  commandsCalls: string[] = []
  activeChannel: string | null = null

  private nextId = 1
  private listeners: Listeners = {
    botMessage: new Set(),
    disconnected: new Set(),
    reconnected: new Set(),
    rateLimited: new Set()
  }

  async login(_token: string): Promise<SelfUser> {
    if (this.failLogin) throw new LoginError(this.failLoginKind)
    return { id: FakeDiscordClient.SELF_ID, username: 'tester', avatarUrl: '' }
  }

  async logout(): Promise<void> {}

  vfCache: Record<string, boolean> = {}
  listGuildsCalls: ({ refresh?: boolean } | undefined)[] = []

  async listGuilds(opts?: { refresh?: boolean }): Promise<GuildInfo[]> {
    this.listGuildsCalls.push(opts)
    if (opts?.refresh) this.vfCache = {}
    for (const g of this.guilds) this.vfCache[g.id] = g.hasVirtualFisher
    return this.guilds
  }

  seedVfCache(map: Record<string, boolean>): void {
    Object.assign(this.vfCache, map)
  }

  getVfCache(): Record<string, boolean> {
    return { ...this.vfCache }
  }

  async listChannels(guildId: string): Promise<ChannelInfo[]> {
    return this.channels[guildId] ?? []
  }

  async getBotCommands(guildId: string): Promise<SlashCommandInfo[]> {
    this.commandsCalls.push(guildId)
    if (this.failCommands) throw new Error('Commandes indisponibles')
    return this.commands
  }

  async sendSlash(channelId: string, command: string, options?: SlashOptions): Promise<void> {
    if (this.failSend) throw new Error('Envoi impossible')
    this.sent.push({ channelId, command, options })
  }

  setActiveChannel(channelId: string | null): void {
    this.activeChannel = channelId
  }

  on<E extends keyof DiscordEventMap>(event: E, cb: DiscordEventMap[E]): () => void {
    const set = this.listeners[event] as Set<DiscordEventMap[E]>
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  /** Mirrors the real filter: delivered only if the message is in the active channel. */
  emitBot(m: Partial<BotMessage> = {}): void {
    const msg: BotMessage = {
      id: `m${this.nextId++}`,
      channelId: this.activeChannel ?? 'c1',
      content: '',
      embeds: [],
      ephemeral: false,
      isEdit: false,
      interactionUserId: FakeDiscordClient.SELF_ID,
      ...m
    }
    if (msg.channelId !== this.activeChannel) return
    for (const cb of [...this.listeners.botMessage]) cb(msg)
  }

  emitDisconnect(): void {
    for (const cb of [...this.listeners.disconnected]) cb()
  }

  emitReconnect(): void {
    for (const cb of [...this.listeners.reconnected]) cb()
  }

  emitRateLimited(retryAfterMs: number): void {
    for (const cb of [...this.listeners.rateLimited]) cb(retryAfterMs)
  }
}
