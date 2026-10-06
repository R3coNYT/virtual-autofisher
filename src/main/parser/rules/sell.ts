import { parseNumber, type Rule } from '../text'
import { parseXp } from './catch'

export const sellRule: Rule = (_m, text) => {
  if (!/you sold|\bsold\b.*\bfor\b/i.test(text)) return null
  const dollar = /\$\s*([\d,.]+\s*[kmbt]?)/i.exec(text)
  const forN = /\bfor\s+([\d,.]+\s*[kmbt]?)/i.exec(text)
  const earned = parseNumber(dollar?.[1] ?? forN?.[1] ?? '')
  if (earned === null) return null
  return { kind: 'sell', earned, xp: parseXp(text) }
}
