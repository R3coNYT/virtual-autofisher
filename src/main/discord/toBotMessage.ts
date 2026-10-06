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
  /** Message components; Virtual Fisher's replies are "Components V2" (no content, no embeds). */
  components?: ComponentLike[] | null
}

type AttachmentLike = { url?: string | null; contentType?: string | null; name?: string | null }

/** Structural subset of the library's V2 components (type is a string name, or the raw number). */
export type ComponentLike = {
  type: string | number | null
  content?: string | null
  components?: ComponentLike[] | null
  accessory?: ComponentLike | null
  items?: { media?: { url?: string | null } | null }[] | null
  media?: { url?: string | null } | null
}

const CONTAINER = new Set<string | number>(['CONTAINER', 17])
const TEXT_DISPLAY = new Set<string | number>(['TEXT_DISPLAY', 10])
const SECTION = new Set<string | number>(['SECTION', 9])
const MEDIA_GALLERY = new Set<string | number>(['MEDIA_GALLERY', 12])
const THUMBNAIL = new Set<string | number>(['THUMBNAIL', 11])

/** Collects the text and the first image of a V2 component tree (buttons are ignored). */
function walk(c: ComponentLike, acc: { texts: string[]; image?: string }): void {
  const t = c.type ?? ''
  if (TEXT_DISPLAY.has(t) && c.content) acc.texts.push(c.content)
  else if (MEDIA_GALLERY.has(t)) acc.image ??= c.items?.find((i) => i.media?.url)?.media?.url ?? undefined
  else if (THUMBNAIL.has(t)) acc.image ??= c.media?.url ?? undefined
  if (CONTAINER.has(t) || SECTION.has(t)) for (const child of c.components ?? []) walk(child, acc)
  if (c.accessory) walk(c.accessory, acc)
}

// A heading (`### Title`) or a line that is entirely bold (`**Title**`).
const HEADING = /^(?:#{1,3}\s+(.+?)|\*\*([^*]+)\*\*)\s*$/

/**
 * Turns V2 components into synthetic embeds so the parser keeps working on one shape:
 * one embed per top-level container (loose text displays/sections form one more).
 * The first line becomes the title when it is a heading or a bold-only line.
 */
export function componentsToEmbeds(components: ComponentLike[]): BotMessage['embeds'] {
  const groups: ComponentLike[][] = []
  const loose: ComponentLike[] = []
  for (const c of components) {
    if (CONTAINER.has(c.type ?? '')) groups.push([c])
    else loose.push(c)
  }
  if (loose.length) groups.push(loose)
  const embeds: BotMessage['embeds'] = []
  for (const group of groups) {
    const acc: { texts: string[]; image?: string } = { texts: [] }
    for (const c of group) walk(c, acc)
    const lines = acc.texts.join('\n').split('\n')
    const h = HEADING.exec(lines[0]?.trim() ?? '')
    const title = h ? (h[1] ?? h[2]).trim() : undefined
    const description = (h ? lines.slice(1) : lines).join('\n').trim()
    if (!title && !description && !acc.image) continue
    embeds.push({ title, description: description || undefined, fields: [], imageUrl: acc.image })
  }
  return embeds
}

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
  if (msg.components?.length) out.embeds.push(...componentsToEmbeds(msg.components))
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
