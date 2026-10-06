import type { DeepPartial, GameSnapshot } from '../shared/types'

/**
 * Applies a `game.patch` to the snapshot. Each top-level section present in the patch is
 * shallow-merged (so `session.catches` keeps the other session fields), but every nested value
 * (fishBySpecies, totals, rare, bait, arrays...) is REPLACED wholesale: a key missing from a
 * replaced value means it was removed. The log is not part of patches (see 'log.append').
 */
export function applyGamePatch(prev: GameSnapshot, patch: DeepPartial<GameSnapshot>): GameSnapshot {
  const next: Record<string, unknown> = { ...prev }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'log' || value === undefined) continue
    const old = (prev as Record<string, unknown>)[key]
    const isSection = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
    next[key] = isSection(value) && isSection(old) ? { ...old, ...value } : value
  }
  return next as GameSnapshot
}

export function emptySnapshot(): GameSnapshot {
  return {
    account: {
      balance: null,
      level: null,
      xpToNext: null,
      rod: null,
      biome: null,
      bait: null,
      rare: { gold: 0, emerald: 0, lava: 0, diamond: 0 },
      totals: {}
    },
    boosts: [],
    quests: [],
    session: {
      startedAt: null,
      catches: 0,
      fishBySpecies: {},
      moneyEarned: 0,
      xpEarned: 0,
      sells: 0,
      captchas: 0,
      commandsSent: 0,
      rareCaught: { gold: 0, emerald: 0, lava: 0, diamond: 0 }
    },
    nextFishAt: null,
    nextDailyAt: null,
    log: []
  }
}
