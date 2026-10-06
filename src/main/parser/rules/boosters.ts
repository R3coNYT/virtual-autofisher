import { parseNumber, titlesOf, type Rule } from '../text'

/** /boosters: "Personal Boosters: 1." or "You have no boosters! Get some by donating, or voting." */
export const boostersRule: Rule = (m, text) => {
  if (/you have no boosters/i.test(text)) return { kind: 'boosters', personal: 0 }
  const line = /personal boosters?\s*:\s*([^\n]*)/i.exec(text)
  if (line) return { kind: 'boosters', personal: parseNumber(line[1]) ?? 0 }
  if (titlesOf(m).some((t) => /your boosters/i.test(t))) return { kind: 'boosters', personal: 0 }
  return null
}
