import { titlesOf, type Rule } from '../text'

export const dailyRule: Rule = (m, text) => {
  if (titlesOf(m).some((t) => /quest/i.test(t))) return null
  if (/on cooldown/i.test(text)) return null // "Daily reward on cooldown! (10h 20m 25s)" is a cooldown
  if (!/daily reward|(?:claimed|collected|received).{0,20}daily|daily.{0,20}(?:claimed|collected)/i.test(text)) return null
  return { kind: 'daily', reward: text.split('\n').join(' ').trim() }
}
