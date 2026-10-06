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
  return loadCapture('real', name, selfId)
}

/**
 * Components V2 messages rebuilt from screenshots (tests/fixtures/messages/v2), same shape as
 * the real captures: used where the exact payload was not captured (e.g. /boosts, /boosters).
 */
export function loadV2(name: string, selfId = REAL_SELF_ID): BotMessage {
  return loadCapture('v2', name, selfId)
}

function loadCapture(dir: 'real' | 'v2', name: string, selfId: string): BotMessage {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/messages', dir, `${name}.json`), 'utf8')
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

/** V2 fixture for the engine; a fresh id each call so repeated replies are not taken for edits. */
let v2Seq = 0
export function v2ForEngine(name: string): Partial<BotMessage> {
  const { channelId: _drop, ...rest } = loadV2(name)
  return { ...rest, id: `${rest.id}-${++v2Seq}`, interactionUserId: 'me' }
}
