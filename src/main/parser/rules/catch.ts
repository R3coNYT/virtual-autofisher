import { descriptionOf, lines, parseNumber, type Rule } from '../text'
import type { CatchItem } from '../../../shared/types'

/** Lines that are never a caught item (rewards, XP, chests, quest and level-up text). */
const NOT_ITEM =
  /\bxp\b|level up|balance|boost|^#|treasure|crate|chest|you caught|\$|quest complete|\btier\s*\d|^reward\b|received|you found|you got|^\d+\s*x\s+\w+\s+crate/i

export function parseXp(text: string): number | undefined {
  const m = /\+?\s*([\d,.]+\s*[kmb]?)\s*xp\b/i.exec(text)
  return (m && parseNumber(m[1])) || undefined
}

/** XP of the catch: the "+N XP" line (not the chest's "You got N XP" line). */
function catchXp(all: string[], text: string): number | undefined {
  for (const line of all) {
    const m = /^\+\s*([\d,.]+\s*[kmb]?)\s*xp\b/i.exec(line)
    if (m) return parseNumber(m[1]) ?? undefined
  }
  return parseXp(text)
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

const CHEST_FISH = /you got\s+(\d[\d,]*)\s+(gold|emerald|lava|diamond)\s+fish\b.*\bfrom the (?:chest|crate)/i
const TREASURE = /\byou found an?\b.*\b(?:chest|crate)\b|treasure/i

export const catchRule: Rule = (m, text) => {
  if (!/you caught/i.test(text)) return null
  const description = descriptionOf(m)
  const all = lines(text)
  const start = all.findIndex((l) => /you caught/i.test(l))

  // the items are the consecutive item lines right after "You caught:"
  const items: CatchItem[] = []
  const rest = all[start].replace(/^.*?you caught\s*:?/i, '').trim()
  const candidates = rest ? [rest, ...all.slice(start + 1)] : all.slice(start + 1)
  for (const line of candidates) {
    const item = parseItem(line)
    if (!item) break
    items.push(item)
  }

  const treasure: string[] = []
  const questsCompleted: string[] = []
  all.forEach((line, i) => {
    const chestFish = CHEST_FISH.exec(line)
    if (chestFish) {
      const kind = chestFish[2].toLowerCase()
      items.push({ name: `${kind[0].toUpperCase()}${kind.slice(1)} Fish`, count: parseNumber(chestFish[1]) ?? 1 })
    } else if (TREASURE.test(line)) treasure.push(line)
    if (/^quest complete/i.test(line) && all[i + 1]) questsCompleted.push(all[i + 1].replace(/[.!]+$/, '').trim())
  })

  const lu = /level up!?\D*(\d+)/i.exec(text)
  return {
    kind: 'catch',
    items,
    xp: catchXp(all, text),
    levelUp: lu ? parseInt(lu[1], 10) : undefined,
    treasure: treasure.length ? treasure : undefined,
    questsCompleted: questsCompleted.length ? questsCompleted : undefined,
    raw: description || text
  }
}
