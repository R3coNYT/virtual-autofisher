import type { LogEntry, RareCounts } from '../shared/types'

const RARE_KEYS: (keyof RareCounts)[] = ['gold', 'emerald', 'lava', 'diamond']
const RARE_LABEL: Record<keyof RareCounts, string> = { gold: 'Gold Fish', emerald: 'Emerald Fish', lava: 'Lava Fish', diamond: 'Diamond Fish' }

/** Highest level announced by a level-up log entry (structured `levelUp` field), or null. */
export function levelUpFromLog(newLog: LogEntry[]): number | null {
  let level: number | null = null
  for (const l of newLog) if (l.levelUp !== undefined) level = Math.max(level ?? 0, l.levelUp)
  return level
}

/** English labels of the rare fish whose session count went up between two snapshots. */
export function rareIncreases(prev: RareCounts, next: Partial<RareCounts>): string[] {
  return RARE_KEYS.filter((k) => (next[k] ?? prev[k]) > prev[k]).map((k) => RARE_LABEL[k])
}
