import type { Boost } from '../../../shared/types'
import { afterColon, lines, parseDuration, titlesOf, type Rule } from '../text'

/** Virtual Fisher's own boost lines ("Personal Boost: 9m 43s", "Global Boost Duration: 3h 24m 35s"). */
const OWN_BOOST = /^(personal|global)\s+boost\b/i
const CURRENT_BOOSTER = /^current booster\s*:/i

export function makeBoostsRule(now: number): Rule {
  return (m, text) => {
    if (!titlesOf(m).some((t) => /boost/i.test(t)) && !/^active boosts/im.test(text)) return null
    const active: Boost[] = []
    let booster: string | undefined
    for (const line of lines(text)) {
      if (CURRENT_BOOSTER.test(line)) {
        booster = afterColon(line) || undefined
        continue
      }
      const dur = parseDuration(line)
      if (dur === null) continue
      const own = OWN_BOOST.exec(line)
      const name = own
        ? own[1][0].toUpperCase() + own[1].slice(1).toLowerCase()
        : line.split(/:|\s-\s|\bends\b|\bremaining\b|\s\d/i)[0].trim()
      if (name) active.push({ name, endsAt: now + dur })
    }
    const global = active.find((b) => b.name === 'Global')
    if (global && booster) global.by = booster
    return { kind: 'boosts', active }
  }
}
