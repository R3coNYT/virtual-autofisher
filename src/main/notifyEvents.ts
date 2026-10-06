import type { LogEntry, RareCounts } from '../shared/types'

const RARE_KEYS: (keyof RareCounts)[] = ['gold', 'emerald', 'lava', 'diamond']
const RARE_LABEL: Record<keyof RareCounts, string> = { gold: 'or', emerald: 'émeraude', lava: 'lave', diamond: 'diamant' }

/** Highest level announced by a highlighted "Niveau N atteint !" log entry, or null. */
export function levelUpFromLog(newLog: LogEntry[]): number | null {
  let level: number | null = null
  for (const l of newLog) {
    const m = l.highlight ? /^Niveau (\d+) atteint/.exec(l.text) : null
    if (m) level = Math.max(level ?? 0, Number(m[1]))
  }
  return level
}

/** French labels of the rare fish whose session count went up between two snapshots. */
export function rareIncreases(prev: RareCounts, next: Partial<RareCounts>): string[] {
  return RARE_KEYS.filter((k) => (next[k] ?? prev[k]) > prev[k]).map((k) => RARE_LABEL[k])
}
