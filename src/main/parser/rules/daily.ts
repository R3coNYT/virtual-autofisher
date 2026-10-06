import { parseDuration, titlesOf, type Rule } from '../text'

/** "Next daily in 23h 59m", "come back in …", "available again in …": when the next daily opens. */
const NEXT = /\b(?:next daily|come back|again|available)\b[^\n]*/i

export const dailyRule: Rule = (m, text) => {
  if (titlesOf(m).some((t) => /quest/i.test(t))) return null
  if (/on cooldown/i.test(text)) return null // "Daily reward on cooldown! (10h 20m 25s)" is a cooldown
  if (!/daily reward|(?:claimed|collected|received).{0,20}daily|daily.{0,20}(?:claimed|collected)/i.test(text)) return null
  const next = NEXT.exec(text)
  const nextInMs = next ? parseDuration(next[0]) : null
  return {
    kind: 'daily',
    reward: text.split('\n').join(' ').trim(),
    ...(nextInMs !== null && nextInMs > 0 ? { nextInMs } : {})
  }
}
