import { afterColon, lines, parseNumber, titlesOf, type Rule } from '../text'

export const inventoryRule: Rule = (m, text) => {
  if (!titlesOf(m).some((t) => /inventory of/i.test(t)) && !/inventory of/i.test(text)) return null
  const rare = { gold: 0, emerald: 0, lava: 0, diamond: 0 }
  let balance: number | null = null
  let level: number | null = null
  let xpToNext: number | undefined
  let rod: string | undefined
  let biome: string | undefined
  let bait: { name: string; count: number } | undefined
  for (const line of lines(text)) {
    if (/balance:/i.test(line)) balance = parseNumber(afterColon(line))
    else if (/xp to next level/i.test(line)) {
      const lv = /level\s*(\d+)/i.exec(line)
      if (lv) level = parseInt(lv[1], 10)
      const frac = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*xp to next/i.exec(line) // "764,946/1,062,500 XP to next level"
      const xp = /([\d,.]+\s*[kmb]?)\s*xp to next/i.exec(line)
      if (frac) xpToNext = (parseNumber(frac[2]) ?? 0) - (parseNumber(frac[1]) ?? 0)
      else if (xp) xpToNext = parseNumber(xp[1]) ?? undefined
    } else if (/currently using/i.test(line)) rod = line.replace(/^.*currently using/i, '').replace(/[.!]+$/, '').trim()
    else if (/current biome:/i.test(line)) biome = afterColon(line)
    else if (/gold(?:en)? fish/i.test(line)) rare.gold = parseNumber(afterColon(line)) ?? 0
    else if (/emerald fish/i.test(line)) rare.emerald = parseNumber(afterColon(line)) ?? 0
    else if (/lava fish/i.test(line)) rare.lava = parseNumber(afterColon(line)) ?? 0
    else if (/diamond fish/i.test(line)) rare.diamond = parseNumber(afterColon(line)) ?? 0
    else if (/\bbait\b/i.test(line)) {
      const v = afterColon(line)
      const c = /x\s*(\d[\d,]*)|\((\d[\d,]*)\)|(\d[\d,]*)\s*x?$/i.exec(v)
      const count = c ? (parseNumber(c[1] ?? c[2] ?? c[3]) ?? 0) : 0
      bait = { name: v.replace(c?.[0] ?? '', '').trim(), count }
    } else if (/\brod\b/i.test(line)) rod = afterColon(line)
  }
  if (balance === null || level === null) return null
  return { kind: 'inventory', balance, level, xpToNext, rod, biome, bait, rare }
}
