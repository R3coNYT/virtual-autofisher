/**
 * The subset of Discord markdown Virtual Fisher uses, parsed into plain data (no HTML, no
 * dangerouslySetInnerHTML): headings, `-#` subtext, **bold**, *italic*, `code`, custom emoji
 * and backslash escapes. Unknown or unclosed markers are kept as text.
 */
export type Span =
  | { kind: 'text' | 'bold' | 'italic' | 'code'; text: string }
  | { kind: 'emoji'; id: string; name: string; animated: boolean }

export type Block = { kind: 'h1' | 'h2' | 'h3' | 'sub' | 'p'; spans: Span[] } | { kind: 'blank' }

// order matters: escapes, emoji, code, bold before italic
const TOKEN = /\\([\\*_`~|>#-])|<(a?):(\w+):(\d+)>|`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\n]+)\*|_([^_\n]+)_/g

export function parseInline(line: string): Span[] {
  const spans: Span[] = []
  const push = (s: Span): void => {
    const last = spans.at(-1)
    if (s.kind === 'text' && last?.kind === 'text') last.text += s.text
    else if (s.kind !== 'text' || s.text) spans.push(s)
  }
  let i = 0
  for (const m of line.matchAll(TOKEN)) {
    push({ kind: 'text', text: line.slice(i, m.index) })
    i = m.index + m[0].length
    if (m[1] !== undefined) push({ kind: 'text', text: m[1] })
    else if (m[4] !== undefined) push({ kind: 'emoji', id: m[4], name: m[3], animated: m[2] === 'a' })
    else if (m[5] !== undefined) push({ kind: 'code', text: m[5] })
    else if (m[6] !== undefined) push({ kind: 'bold', text: unescape(m[6]) })
    else push({ kind: 'italic', text: unescape(m[7] ?? m[8]) })
  }
  push({ kind: 'text', text: line.slice(i) })
  // bold text may itself contain an emoji: split it out so it renders as an image
  return spans.flatMap((s) => (s.kind === 'bold' && /<a?:\w+:\d+>/.test(s.text) ? splitBold(s.text) : [s]))
}

function splitBold(text: string): Span[] {
  return parseInline(text).map((s) => (s.kind === 'text' ? { kind: 'bold', text: s.text } : s))
}

const unescape = (s: string): string => s.replace(/\\([\\*_`~|>#-])/g, '$1')

export function parseDiscordMarkdown(text: string): Block[] {
  return text.split('\n').map((line): Block => {
    const t = line.trimEnd()
    if (!t.trim()) return { kind: 'blank' }
    const h = /^(#{1,3})\s+(.*)$/.exec(t)
    if (h) return { kind: (['h1', 'h2', 'h3'] as const)[h[1].length - 1], spans: parseInline(h[2]) }
    const sub = /^-#\s+(.*)$/.exec(t)
    if (sub) return { kind: 'sub', spans: parseInline(sub[1]) }
    return { kind: 'p', spans: parseInline(t) }
  })
}

/** Discord CDN URL of a custom emoji. */
export const emojiUrl = (id: string, animated: boolean): string =>
  `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=48`
