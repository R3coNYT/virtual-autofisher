import { lines, titlesOf, type Rule } from '../text'

export const questsRule: Rule = (m, text) => {
  if (!titlesOf(m).some((t) => /\bquests?\b/i.test(t))) return null
  const quests: { label: string; progress: string; done: boolean }[] = []
  for (const line of lines(text)) {
    const p = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(line)
    if (!p) continue
    const a = parseInt(p[1].replace(/,/g, ''), 10)
    const b = parseInt(p[2].replace(/,/g, ''), 10)
    const label = line
      .replace(p[0], '')
      .replace(/[✅✔☑❌✖]/gu, '')
      .replace(/^[\s:\-–]+|[\s:\-–]+$/g, '')
    quests.push({
      label,
      progress: p[0].replace(/\s/g, ''),
      done: /✅|✔|☑|complete/i.test(line) || (b > 0 && a >= b)
    })
  }
  return { kind: 'quests', quests }
}
