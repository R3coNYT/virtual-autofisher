import { descriptionOf, lines, parseNumber, type Rule } from '../text'
import type { CatchItem } from '../../../shared/types'

const NOT_ITEM = /\bxp\b|level up|balance|boost|^#|treasure|crate|chest|you caught|\$/i

export function parseXp(text: string): number | undefined {
  const m = /\+?\s*([\d,.]+\s*[kmb]?)\s*xp\b/i.exec(text)
  return (m && parseNumber(m[1])) || undefined
}

function parseItem(line: string): CatchItem | null {
  if (NOT_ITEM.test(line) || !/[a-z]/i.test(line)) return null
  let m = /^(\d[\d,]*)\s*x\s+(.+)$/i.exec(line)
  if (m) return { name: m[2].replace(/[.!]+$/, '').trim(), count: parseNumber(m[1]) ?? 1 }
  m = /^(.+?)\s+x\s*(\d[\d,]*)[.!]*$/i.exec(line)
  if (m) return { name: m[1].trim(), count: parseNumber(m[2]) ?? 1 }
  m = /^(\d[\d,]*)\s+(\D.*)$/.exec(line) // "2 Squid" (current Virtual Fisher format)
  if (m) return { name: m[2].replace(/[.!]+$/, '').trim(), count: parseNumber(m[1]) ?? 1 }
  if (line.length > 40 || line.includes(':')) return null
  return { name: line.replace(/[.!]+$/, '').trim(), count: 1 }
}

export const catchRule: Rule = (m, text) => {
  if (!/you caught/i.test(text)) return null
  const description = descriptionOf(m)
  const items: CatchItem[] = []
  const treasure: string[] = []
  for (const line of lines(description || text)) {
    if (/treasure|crate|chest/i.test(line)) treasure.push(line)
    else {
      const item = parseItem(line)
      if (item) items.push(item)
    }
  }
  const lu = /level up!?\D*(\d+)/i.exec(text)
  return {
    kind: 'catch',
    items,
    xp: parseXp(text),
    levelUp: lu ? parseInt(lu[1], 10) : undefined,
    treasure: treasure.length ? treasure : undefined,
    raw: description || text
  }
}
