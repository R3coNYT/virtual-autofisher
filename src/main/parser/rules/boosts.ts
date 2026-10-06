import { lines, parseDuration, titlesOf, type Rule } from '../text'

export function makeBoostsRule(now: number): Rule {
  return (m, text) => {
    if (!titlesOf(m).some((t) => /boost/i.test(t)) && !/^active boosts/im.test(text)) return null
    const active: { name: string; endsAt: number }[] = []
    for (const line of lines(text)) {
      const dur = parseDuration(line)
      if (dur === null) continue
      const name = line.split(/:|\s-\s|\bends\b|\bremaining\b|\s\d/i)[0].trim()
      if (name) active.push({ name, endsAt: now + dur })
    }
    return { kind: 'boosts', active }
  }
}
