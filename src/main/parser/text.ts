import type { BotMessage, GameEvent } from '../../shared/types'

/** A parser rule: returns a GameEvent when it recognises the message, otherwise null. */
export type Rule = (m: BotMessage, text: string) => GameEvent | null

/**
 * Strips custom emoji markup (<:name:id>, <a:name:id>), :shortcodes:, markdown (*_~`)
 * and collapses horizontal whitespace. Newlines are kept so rules can work line by line.
 */
export function cleanText(s: string): string {
  return (s ?? '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/:\w+:/g, '')
    .replace(/[*_~`]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .trim()
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }

/** Parses the first number of a string: `1,234`, `$1,234`, `1.2M`, `12.5k`. */
export function parseNumber(s: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?(?![a-z])/i.exec(s ?? '')
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  if (Number.isNaN(n)) return null
  const mult = m[2] ? SUFFIX[m[2].toLowerCase()] : 1
  return Math.round(n * mult)
}

const UNIT_MS: [RegExp, number][] = [
  [/^h(?:ours?|rs?)?$/i, 3_600_000],
  [/^m(?:ins?|inutes?)?$/i, 60_000],
  [/^s(?:ecs?|econds?)?$/i, 1000]
]

/** Parses durations like `5m 30s`, `1h 2m`, `12 seconds`, `2.4 seconds` into milliseconds. */
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi
  const src = s ?? ''
  let total = 0
  let found = false
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const unit = UNIT_MS.find(([r]) => r.test(m![2]))
    if (!unit) continue
    total += parseFloat(m[1]) * unit[1]
    found = true
  }
  return found ? Math.round(total) : null
}

/** Non-empty lines of a text. */
export function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Value after the first ':' of a line (or the whole line), without trailing punctuation. */
export function afterColon(line: string): string {
  const i = line.indexOf(':')
  return (i >= 0 ? line.slice(i + 1) : line).trim().replace(/[.!]+$/, '').trim()
}

/** Cleaned titles of all embeds. */
export function titlesOf(m: BotMessage): string[] {
  return (m.embeds ?? []).map((e) => cleanText(e.title ?? '')).filter(Boolean)
}

/** Cleaned description of the first embed that has one. */
export function descriptionOf(m: BotMessage): string {
  return cleanText((m.embeds ?? []).find((e) => e.description)?.description ?? '')
}

/** Every piece of text of a message (content, titles, descriptions, fields, footers), cleaned, one per line. */
export function buildText(m: BotMessage): string {
  const parts: string[] = [m.content ?? '']
  for (const e of m.embeds ?? []) {
    parts.push(e.title ?? '', e.description ?? '')
    for (const f of e.fields ?? []) parts.push(`${(f.name ?? '').replace(/:\s*$/, '')}: ${f.value ?? ''}`)
    parts.push(e.footer ?? '')
  }
  return parts.map(cleanText).filter(Boolean).join('\n')
}
