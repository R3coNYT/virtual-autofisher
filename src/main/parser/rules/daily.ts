import { titlesOf, type Rule } from '../text'

export const dailyRule: Rule = (m, text) => {
  if (titlesOf(m).some((t) => /quest/i.test(t))) return null
  if (!/daily reward|(?:claimed|collected|received).{0,20}daily|daily.{0,20}(?:claimed|collected)/i.test(text)) return null
  return { kind: 'daily', reward: text.split('\n').join(' ').trim() }
}
