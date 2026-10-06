import { parseDuration, type Rule } from '../text'

export const cooldownRule: Rule = (_m, text) => {
  const m = /\b(?:you must wait|please wait|wait)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*([a-z]*)/i.exec(text)
  if (!m) return null
  const withUnit = parseDuration(`${m[1]}${m[2] ? ' ' + m[2] : ''}`)
  return { kind: 'cooldown', waitMs: withUnit ?? Math.round(parseFloat(m[1]) * 1000) }
}
