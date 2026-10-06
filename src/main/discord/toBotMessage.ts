import type { BotMessage } from '../../shared/types'
import { VIRTUAL_FISHER_ID } from './DiscordClient'

type IdLike = { id: string }
type Iter<T> = T[] | { values(): IterableIterator<T> }

/** Structural subset of the library's Message that we read (keeps tests free of the library). */
export type LibMessageLike = {
  id: string
  channelId: string
  content: string
  author: IdLike
  embeds: {
    title?: string | null
    description?: string | null
    fields?: { name: string; value: string }[]
    image?: { url?: string | null } | null
    footer?: { text?: string | null } | null
  }[]
  /** Raw number or a BitField-like object. */
  flags: number | { bitfield: number }
  interaction?: { user: IdLike } | null
  interactionMetadata?: { user: IdLike } | null
  mentions: { users: Iter<IdLike> | Map<string, IdLike> }
}

const EPHEMERAL = 64

function flagBits(flags: LibMessageLike['flags']): number {
  return typeof flags === 'number' ? flags : (flags?.bitfield ?? 0)
}

function mentionsUser(msg: LibMessageLike, selfId: string): boolean {
  const users = msg.mentions?.users
  if (users) {
    const list = Array.isArray(users) ? users : Array.from(users.values())
    if (list.some((u) => u.id === selfId)) return true
  }
  return msg.content.includes(`<@${selfId}>`) || msg.content.includes(`<@!${selfId}>`)
}

/**
 * SAFETY-CRITICAL: the only filter keeping other players' Virtual Fisher replies
 * away from the engine. Accept only messages from the bot that belong to us.
 */
export function toBotMessage(msg: LibMessageLike, selfId: string, isEdit = false): BotMessage | null {
  if (msg.author?.id !== VIRTUAL_FISHER_ID) return null
  const interactionUserId = msg.interactionMetadata?.user.id ?? msg.interaction?.user.id
  const ephemeral = (flagBits(msg.flags) & EPHEMERAL) !== 0
  const ours = interactionUserId === selfId || mentionsUser(msg, selfId) || ephemeral
  if (!ours) return null

  const out: BotMessage = {
    id: msg.id,
    channelId: msg.channelId,
    content: msg.content ?? '',
    embeds: (msg.embeds ?? []).map((e) => ({
      title: e.title ?? undefined,
      description: e.description ?? undefined,
      fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
      imageUrl: e.image?.url ?? undefined,
      footer: e.footer?.text ?? undefined
    })),
    ephemeral,
    isEdit
  }
  if (interactionUserId !== undefined) out.interactionUserId = interactionUserId
  return out
}
