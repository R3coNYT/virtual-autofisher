import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'discord.js-selfbot-v13'
import type { BotMessage, ChannelInfo, GuildInfo, SelfUser, SlashCommandInfo } from '../../shared/types'
import { maskSecrets } from '../util/maskSecrets'
import type { Logger } from '../util/logger'
import { LoginError, VIRTUAL_FISHER_ID, type DiscordClient, type DiscordEventMap, type SlashOptions } from './DiscordClient'
import { orderSlashArgs } from './orderSlashArgs'
import { toBotMessage, type LibMessageLike } from './toBotMessage'

const LOGIN_TIMEOUT_MS = 20_000
const MEMBER_FETCH_CONCURRENCY = 3

/** Auth rejection (lib TOKEN_INVALID / HTTP 401) vs. anything else (transport, timeout). */
export function classifyLoginError(e: unknown): LoginError {
  const err = e as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown } | null
  const msg = typeof err?.message === 'string' ? err.message : String(e)
  const rejected =
    err?.code === 'TOKEN_INVALID' || err?.status === 401 || err?.httpStatus === 401 || /invalid token|401/i.test(msg)
  return new LoginError(rejected ? 'invalidToken' : 'network')
}

type Listeners = { [E in keyof DiscordEventMap]: Set<DiscordEventMap[E]> }

type RawCommand = {
  id: string
  name: string
  version: string
  application_id: string
  options?: { name: string; type: number; required?: boolean; choices?: { name: string; value: unknown }[] }[]
}

type RestRoute = { get(): Promise<unknown> }
type RestApi = Record<string, Record<string, Record<string, RestRoute>>>

export type SelfbotClientOpts = { captureDir?: string; logger?: Logger; createClient?: () => Client }

const defaultClient = (): Client => new Client({ checkUpdate: false } as ConstructorParameters<typeof Client>[0])

/**
 * The only module touching discord.js-selfbot-v13.
 *
 * Command listing: the lib has no public manager for it. Its own `sendSlash` uses
 * `TextBasedChannel#searchInteraction`, which GETs `guilds/{id}/application-command-index`
 * through `client.api`. We call that same REST route directly (per guild, not per channel)
 * and filter on VF's application id. Our per-guild cache serves getBotCommands/option ordering only;
 * the lib's `sendSlash(botId, name, ...args)` re-fetches the index itself to resolve the
 * command itself, with positional args in option order.
 */
export class SelfbotClient implements DiscordClient {
  private client: Client | null = null
  private selfId: string | null = null
  private activeChannelId: string | null = null
  private disconnected = false
  private readonly listeners: Listeners = {
    botMessage: new Set(),
    disconnected: new Set(),
    reconnected: new Set(),
    rateLimited: new Set()
  }
  private readonly vfByGuild = new Map<string, boolean>()
  private readonly commandsByGuild = new Map<string, SlashCommandInfo[]>()
  /** Last slash command handed to the library, to give context to its unhandled rejections. */
  lastSlash: { command: string; at: number } | null = null

  constructor(private readonly opts: SelfbotClientOpts = {}) {}

  /** Enables (dir) or disables (null) raw message capture at runtime. */
  setCaptureDir(dir: string | null): void {
    this.opts.captureDir = dir ?? undefined
  }

  on<E extends keyof DiscordEventMap>(event: E, cb: DiscordEventMap[E]): () => void {
    const set = this.listeners[event] as Set<DiscordEventMap[E]>
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  private emit<E extends keyof DiscordEventMap>(event: E, ...args: Parameters<DiscordEventMap[E]>): void {
    for (const cb of [...this.listeners[event]] as ((...a: unknown[]) => void)[]) {
      try {
        cb(...args)
      } catch (e) {
        this.opts.logger?.error(`listener ${event} failed`, e)
      }
    }
  }

  setActiveChannel(channelId: string | null): void {
    this.activeChannelId = channelId
  }

  async login(token: string): Promise<SelfUser> {
    // Build and log in the NEW client first: a failure must leave the current one untouched.
    const client = this.opts.createClient ? this.opts.createClient() : defaultClient()
    this.attach(client)

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new LoginError('network')), LOGIN_TIMEOUT_MS)
        const done = (err?: Error): void => {
          clearTimeout(timer)
          if (err) reject(err)
          else resolve()
        }
        client.once('ready', () => done())
        client.login(token).catch((e: unknown) => {
          // never log the raw error without masking: it may echo the token
          const msg = maskSecrets(e instanceof Error ? e.message : String(e))
          this.opts.logger?.warn(`login failed: ${msg}`)
          done(classifyLoginError(e))
        })
      })
    } catch (e) {
      this.destroy(client)
      throw e instanceof LoginError ? e : new LoginError('network')
    }

    const u = client.user
    if (!u) {
      this.destroy(client)
      throw new LoginError('network')
    }
    const old = this.client
    this.client = client
    this.selfId = u.id
    this.disconnected = false
    this.vfByGuild.clear()
    this.commandsByGuild.clear()
    if (old) this.destroy(old)
    return { id: u.id, username: u.username, avatarUrl: u.displayAvatarURL() }
  }

  async logout(): Promise<void> {
    const c = this.client
    this.client = null
    this.selfId = null
    this.disconnected = false
    this.vfByGuild.clear()
    this.commandsByGuild.clear()
    if (c) this.destroy(c)
  }

  private destroy(c: Client): void {
    try {
      c.removeAllListeners()
      c.destroy()
    } catch (e) {
      this.opts.logger?.warn('destroy failed', e)
    }
  }

  private attach(client: Client): void {
    const current = (): boolean => this.client === client // events of a not-yet-adopted client are ignored
    const markDisconnected = (): void => {
      if (!current() || this.disconnected) return
      this.disconnected = true
      this.emit('disconnected')
    }
    const markReconnected = (): void => {
      if (!current() || !this.disconnected) return
      this.disconnected = false
      this.emit('reconnected')
    }
    client.on('shardDisconnect', markDisconnected)
    client.on('shardReconnecting', markDisconnected)
    client.on('shardResume', markReconnected)
    client.on('shardReady', markReconnected)
    client.on('rateLimit', (d) => void (current() && this.emit('rateLimited', d.timeout)))
    client.on('messageCreate', (m) => void (current() && this.handleMessage(m as unknown as LibMessageLike, false)))
    client.on('messageUpdate', (_old, m) => void (current() && this.handleMessage(m as unknown as LibMessageLike, true)))
    client.on('error', (e) => this.opts.logger?.error('client error', e))
  }

  private handleMessage(msg: LibMessageLike, isEdit: boolean): void {
    if (!this.selfId || !this.activeChannelId || msg.channelId !== this.activeChannelId) return
    const bm = toBotMessage(msg, this.selfId, isEdit)
    if (!bm) return
    void this.capture(bm, msg.components)
    this.emit('botMessage', bm)
  }

  /** Writes the parsed message plus the raw V2 components (exact bot markdown, for parser calibration). */
  private async capture(bm: BotMessage, components?: LibMessageLike['components']): Promise<void> {
    const dir = this.opts.captureDir
    if (!dir) return
    try {
      const raw = (components ?? []).map((c) => (c as { toJSON?: () => unknown }).toJSON?.() ?? c)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${Date.now()}-${bm.id}.json`), JSON.stringify({ ...bm, rawComponents: raw }, null, 2), 'utf8')
    } catch (e) {
      this.opts.logger?.warn('capture failed', e)
    }
  }

  private requireClient(): Client {
    if (!this.client || !this.selfId) throw new Error('Non connecté')
    return this.client
  }

  async listGuilds(): Promise<GuildInfo[]> {
    const client = this.requireClient()
    const guilds = [...client.guilds.cache.values()]
    const result: GuildInfo[] = new Array(guilds.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < guilds.length) {
        const i = next++
        const g = guilds[i]
        let has = this.vfByGuild.get(g.id)
        if (has === undefined) {
          try {
            await g.members.fetch(VIRTUAL_FISHER_ID)
            has = true
            this.vfByGuild.set(g.id, true)
          } catch (e) {
            const err = e as { httpStatus?: number; code?: number }
            if (err.httpStatus === 404 || err.code === 10007) {
              has = false // definitive: Unknown Member
              this.vfByGuild.set(g.id, false)
            } else {
              // transient or permission error (403, rate limit, network): fall back, do not cache a failure
              try {
                const idx = await this.fetchCommandIndex(g.id)
                has = idx.applications.some((a) => a.id === VIRTUAL_FISHER_ID || a.bot_id === VIRTUAL_FISHER_ID)
                if (has) this.vfByGuild.set(g.id, true)
              } catch {
                has = false
              }
            }
          }
        }
        result[i] = { id: g.id, name: g.name, iconUrl: g.iconURL(), hasVirtualFisher: has }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MEMBER_FETCH_CONCURRENCY, guilds.length) }, worker))
    return result.sort((a, b) => Number(b.hasVirtualFisher) - Number(a.hasVirtualFisher) || a.name.localeCompare(b.name))
  }

  async listChannels(guildId: string): Promise<ChannelInfo[]> {
    const client = this.requireClient()
    const guild = client.guilds.cache.get(guildId)
    if (!guild) return []
    const me = guild.members.me ?? (await guild.members.fetch(this.selfId as string).catch(() => null))
    if (!me) return []
    const out: ChannelInfo[] = []
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isText() || ch.isThread()) continue
      const perms = ch.permissionsFor(me)
      if (!perms?.has(['SEND_MESSAGES', 'USE_APPLICATION_COMMANDS'])) continue
      out.push({ id: ch.id, name: ch.name, parentName: ch.parent?.name ?? null })
    }
    return out.sort((a, b) => (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.name.localeCompare(b.name))
  }

  private async fetchCommandIndex(
    guildId: string
  ): Promise<{ application_commands: RawCommand[]; applications: { id: string; bot_id?: string }[] }> {
    const client = this.requireClient()
    // See class comment: same REST route the lib's searchInteraction uses.
    const api = (client as unknown as { api: RestApi }).api
    const data = (await api.guilds[guildId]['application-command-index'].get()) as {
      application_commands?: RawCommand[]
      applications?: { id: string; bot_id?: string }[]
    }
    return { application_commands: data.application_commands ?? [], applications: data.applications ?? [] }
  }

  async getBotCommands(guildId: string): Promise<SlashCommandInfo[]> {
    const cached = this.commandsByGuild.get(guildId)
    if (cached) return cached
    const data = await this.fetchCommandIndex(guildId)
    const appIds = new Set(
      data.applications.filter((a) => a.id === VIRTUAL_FISHER_ID || a.bot_id === VIRTUAL_FISHER_ID).map((a) => a.id)
    )
    appIds.add(VIRTUAL_FISHER_ID)
    const cmds: SlashCommandInfo[] = data.application_commands
      .filter((c) => appIds.has(c.application_id))
      .map((c) => ({
        name: c.name,
        id: c.id,
        version: c.version,
        options: (c.options ?? []).map((o) => ({
          name: o.name,
          type: o.type,
          required: o.required ?? false,
          ...(o.choices ? { choices: o.choices.map((ch) => String(ch.value)) } : {})
        }))
      }))
    this.commandsByGuild.set(guildId, cmds)
    return cmds
  }

  async sendSlash(channelId: string, command: string, options: SlashOptions = {}): Promise<void> {
    const client = this.requireClient()
    const channel = client.channels.cache.get(channelId)
    if (!channel || !channel.isText()) throw new Error('Salon introuvable')
    const guildId = 'guildId' in channel ? (channel.guildId as string | null) : null
    const info = guildId ? (await this.getBotCommands(guildId)).find((c) => c.name === command) : undefined
    if (!info) throw new Error(`Commande introuvable : /${command}`)
    const ordered = orderSlashArgs(info, options)
    this.lastSlash = { command, at: Date.now() }
    try {
      await channel.sendSlash(VIRTUAL_FISHER_ID, command, ...ordered)
    } catch (e) {
      // The lib gives up after 5 s when it cannot match the reply to its nonce, although the
      // command went out: the queue's 8 s timeout and the actual bot reply decide instead.
      if (isInteractionTimeout(e)) return
      throw e
    }
  }
}

/** The library's own 5 s "No response from application" rejection (DiscordError INTERACTION_FAILED). */
export function isInteractionTimeout(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'INTERACTION_FAILED'
}
