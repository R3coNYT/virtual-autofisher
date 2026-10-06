import { parseDuration, type Rule } from '../text'

const NUM = String.raw`\d+(?:\.\d+)?`
/**
 * "wait" followed by a contiguous duration: `2.4 seconds`, `20h 12m`, `5 more seconds`,
 * `1 hour, 3 minutes and 2 seconds`. Words after the duration ("before fishing") stop it.
 */
const COOLDOWN = new RegExp(
  String.raw`\b(?:you must wait|please wait|wait)\s+(?:for\s+)?(${NUM}\s*(?:more\s+)?[a-z]*(?:[\s,]+(?:and\s+)?${NUM}\s*(?:more\s+)?[a-z]*)*)`,
  'i'
)

/** "Daily reward on cooldown! (10h 20m 25s)": "on cooldown" followed by a duration on the same line. */
const ON_COOLDOWN = /\bon cooldown\b[^\n]*/i

export const cooldownRule: Rule = (_m, text) => {
  const m = COOLDOWN.exec(text)
  if (!m) {
    const oc = ON_COOLDOWN.exec(text)
    const ms = oc ? parseDuration(oc[0]) : null
    return ms !== null ? { kind: 'cooldown', waitMs: ms } : null
  }
  const span = m[1].replace(/\bmore\s+/gi, '')
  const withUnit = parseDuration(span)
  return { kind: 'cooldown', waitMs: withUnit ?? Math.round(parseFloat(span) * 1000) }
}
