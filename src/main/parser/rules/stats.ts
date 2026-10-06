import { afterColon, lines, parseNumber, titlesOf, type Rule } from '../text'
import type { GameEvent } from '../../../shared/types'

type Stats = Extract<GameEvent, { kind: 'stats' }>

export const statsRule: Rule = (m, text) => {
  if (!titlesOf(m).some((t) => /statistics for/i.test(t)) && !/statistics for/i.test(text)) return null
  const out: Stats = { kind: 'stats', totals: {} }
  for (const line of lines(text)) {
    const n = parseNumber(afterColon(line)) ?? parseNumber(line)
    if (n === null) continue
    if (/crates/i.test(line)) out.crates = n
    else if (/quests/i.test(line)) out.quests = n
    else if (/trips/i.test(line)) out.trips = n
    else if (/daily/i.test(line)) out.dailyStreak = n
    else if (/gold(?:en)?/i.test(line)) out.totals.gold = n
    else if (/emerald/i.test(line)) out.totals.emerald = n
    else if (/lava/i.test(line)) out.totals.lava = n
    else if (/diamond/i.test(line)) out.totals.diamond = n
  }
  return out
}
