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
  /** Collection (Map-like) of attachments; a captcha image may come as a file instead of an embed image. */
  attachments?: Iter<AttachmentLike> | Map<string, AttachmentLike> | null
}

type AttachmentLike = { url?: string | null; contentType?: string | null; name?: string | null }

const EPHEMERAL = 64

function flagBits(flags: LibMessageLike['flags']): number {
  return typeof flags === 'number' ? flags : (flags?.bitfield ?? 0)
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)(?:$|\?)/i

/** URL of the first image attachment, if any. */
function firstImageAttachment(msg: LibMessageLike): string | undefined {
  const a = msg.attachments
  if (!a) return undefined
  const list = Array.isArray(a) ? a : Array.from(a.values())
  const img = list.find(
    (x) => !!x?.url && (/^image\//i.test(x.contentType ?? '') || IMAGE_EXT.test(x.name ?? '') || IMAGE_EXT.test(x.url))
  )
  return img?.url ?? undefined
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
  if (!out.embeds.some((e) => e.imageUrl)) {
    const url = firstImageAttachment(msg)
    if (url) {
      if (out.embeds.length) out.embeds[0].imageUrl = url
      else out.embeds.push({ fields: [], imageUrl: url }) // synthetic embed carrying the image only
    }
  }
  if (interactionUserId !== undefined) out.interactionUserId = interactionUserId
  return out
}
