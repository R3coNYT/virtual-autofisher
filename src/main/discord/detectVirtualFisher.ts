import { VIRTUAL_FISHER_ID } from './DiscordClient'

export type DetectDeps = {
  cache: Map<string, boolean>
  /** Free check: VF is already in the guild's member cache. */
  inMemberCache: () => boolean
  /** The guild's application-command-index (one request). */
  fetchIndex: () => Promise<{ applications: { id: string; bot_id?: string }[] }>
}

/**
 * Whether Virtual Fisher is in the guild. The command index is definitive both ways, so both
 * results are cached; a thrown error (network, 429) is not cached and reads as false for this call.
 */
export async function detectVirtualFisher(guildId: string, d: DetectDeps): Promise<boolean> {
  const known = d.cache.get(guildId)
  if (known !== undefined) return known
  if (d.inMemberCache()) {
    d.cache.set(guildId, true)
    return true
  }
  try {
    const { applications } = await d.fetchIndex()
    const has = applications.some((a) => a.id === VIRTUAL_FISHER_ID || a.bot_id === VIRTUAL_FISHER_ID)
    d.cache.set(guildId, has)
    return has
  } catch {
    return false
  }
}
