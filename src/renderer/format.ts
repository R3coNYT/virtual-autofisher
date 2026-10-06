import type { LogEntry, SlashCommandInfo } from '../shared/types'

const NBSP = '\u00a0'
const intFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

/** 1234567 -> "1 234 567 $" (fr-FR grouping). */
export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${intFmt.format(Math.round(n))}${NBSP}$`
}

function oneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toString().replace('.', ',')
}

/** 1200000 -> "1,2 M"; below 1000 the number is shown as is. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${oneDecimal(n / 1e9)}${NBSP}Md`
  if (abs >= 1e6) return `${oneDecimal(n / 1e6)}${NBSP}M`
  if (abs >= 1e3) return `${oneDecimal(n / 1e3)}${NBSP}k`
  return intFmt.format(n)
}

/** 3_720_000 -> "1 h 02 min"; 245_000 -> "4 min 05 s"; 12_000 -> "12 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (v: number): string => String(v).padStart(2, '0')
  if (h > 0) return `${h} h ${pad(m)} min`
  if (m > 0) return `${m} min ${pad(s)} s`
  return `${s} s`
}

export function catchesPerHour(catches: number, startedAt: number | null, now: number): number | null {
  if (startedAt == null) return null
  const elapsed = now - startedAt
  if (elapsed <= 0) return null
  return Math.round((catches / elapsed) * 3_600_000)
}

export type LogFilter = 'all' | 'catch' | 'trade' | 'system'

export function logFilter(entry: LogEntry, filter: LogFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'catch':
      return entry.type === 'catch'
    case 'trade':
      return entry.type === 'trade'
    case 'system':
      return entry.type === 'system' || entry.type === 'error' || entry.type === 'unknown'
  }
}

export type ParsedCommand =
  | { ok: true; name: string; options: Record<string, string | number> }
  | { ok: false; error: string }

function tokenize(line: string): string[] {
  const tokens: string[] = []
  const re = /(?:[^\s"]|"[^"]*")+/g
  for (const m of line.match(re) ?? []) tokens.push(m.replace(/"([^"]*)"/g, '$1'))
  return tokens
}

/** Parses "/name opt=value opt2=value" against the commands known at runtime. */
export function parseCommandLine(line: string, commands: SlashCommandInfo[]): ParsedCommand {
  const [head, ...rest] = tokenize(line.trim())
  if (!head) return { ok: false, error: 'Saisissez une commande.' }
  const name = head.replace(/^\//, '')
  const cmd = commands.find((c) => c.name === name)
  if (!cmd) return { ok: false, error: `Commande inconnue : /${name}` }
  const options: Record<string, string | number> = {}
  for (const tok of rest) {
    const eq = tok.indexOf('=')
    if (eq <= 0) return { ok: false, error: `Option mal formée « ${tok} » : utilisez nom=valeur.` }
    const key = tok.slice(0, eq)
    const raw = tok.slice(eq + 1)
    const opt = cmd.options.find((o) => o.name === key)
    if (!opt) return { ok: false, error: `Option inconnue « ${key} » pour /${name}.` }
    if (opt.type === 4 || opt.type === 10) {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n)) return { ok: false, error: `L'option « ${key} » doit être un nombre.` }
      options[key] = n
    } else {
      options[key] = raw
    }
  }
  const missing = cmd.options.find((o) => o.required && !(o.name in options))
  if (missing) return { ok: false, error: `Option requise manquante : ${missing.name}.` }
  return { ok: true, name, options }
}

/** Picks the side/amount option names of a coinflip-like command. */
export function coinflipOptionNames(cmd: SlashCommandInfo | undefined): { side: string; amount: string; choices?: string[] } {
  const opts = cmd?.options ?? []
  const side = opts.find((o) => /side|choice|face/i.test(o.name)) ?? opts[0]
  const amount = opts.find((o) => /amount|bet|montant/i.test(o.name)) ?? opts.find((o) => o !== side)
  return { side: side?.name ?? 'side', amount: amount?.name ?? 'amount', choices: side?.choices }
}

/** Option set for `/sell all`: the option whose choices include "all", else the first option, else none. */
export function sellAllOptions(cmd: SlashCommandInfo): Record<string, string | number> {
  const opt =
    cmd.options.find((o) => o.choices?.some((c) => c.toLowerCase() === 'all')) ?? cmd.options[0]
  if (!opt) return {}
  const all = opt.choices?.find((c) => c.toLowerCase() === 'all') ?? 'all'
  return { [opt.name]: all }
}

/** Quest completion 0..1 from a "3/10" style progress string. */
export function questRatio(progress: string, done: boolean): number {
  if (done) return 1
  const m = /(\d[\d\s,.]*)\s*\/\s*(\d[\d\s,.]*)/.exec(progress)
  if (!m) return 0
  const n = (s: string): number => Number(s.replace(/[\s,]/g, ''))
  const total = n(m[2])
  return total > 0 ? Math.min(1, n(m[1]) / total) : 0
}
