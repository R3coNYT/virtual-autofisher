import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toBotMessage, type ComponentLike, type LibMessageLike } from '../../src/main/discord/toBotMessage'
import { VIRTUAL_FISHER_ID } from '../../src/main/discord/DiscordClient'
import type { BotMessage } from '../../src/shared/types'

/** Anonymized user id used in the real fixtures. */
export const REAL_SELF_ID = '111'

type RealCapture = {
  id: string
  channelId: string
  content: string
  isEdit: boolean
  interactionUserId?: string
  rawComponents: ComponentLike[]
}

/**
 * Loads an anonymized real capture (tests/fixtures/messages/real) and converts it through
 * toBotMessage exactly like a live message: Components V2 payload, our interaction metadata.
 */
export function loadReal(name: string, selfId = REAL_SELF_ID): BotMessage {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/messages/real', `${name}.json`), 'utf8')
  ) as RealCapture
  const lib: LibMessageLike = {
    id: raw.id,
    channelId: raw.channelId,
    content: raw.content ?? '',
    author: { id: VIRTUAL_FISHER_ID },
    embeds: [],
    flags: 0,
    interaction: raw.interactionUserId ? { user: { id: raw.interactionUserId } } : null,
    interactionMetadata: null,
    mentions: { users: [] },
    components: raw.rawComponents
  }
  const bm = toBotMessage(lib, selfId, raw.isEdit)
  if (!bm) throw new Error(`fixture ${name} was rejected by toBotMessage`)
  return bm
}

/** Same, without channelId: FakeDiscordClient delivers it to the active channel. */
export function realForEngine(name: string): Partial<BotMessage> {
  const { channelId: _drop, ...rest } = loadReal(name)
  return { ...rest, interactionUserId: 'me' }
}
