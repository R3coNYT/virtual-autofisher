import { parseNumber, type Rule } from '../text'

const PURCHASE = /you (?:bought|purchased)\s+(?:(\d[\d,]*)\s*x?\s*)?(.+?)(?:\s+for\s+\$?\s*([\d,.]+\s*[kmbt]?))?\s*[.!]*\s*$/im

export const purchaseRule: Rule = (_m, text) => {
  const m = PURCHASE.exec(text)
  if (!m) return null
  return {
    kind: 'purchase',
    item: m[2].trim(),
    amount: m[1] ? (parseNumber(m[1]) ?? 1) : 1,
    cost: m[3] ? (parseNumber(m[3]) ?? undefined) : undefined
  }
}
