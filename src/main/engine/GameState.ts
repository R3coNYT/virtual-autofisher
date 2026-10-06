import type { DeepPartial, GameEvent, GameSnapshot, LogEntry, RareCounts, SessionSummary } from '../../shared/types'

type Session = GameSnapshot['session']
type PatchCb = (patch: DeepPartial<GameSnapshot>, newLog: LogEntry[]) => void
type Body = Omit<GameSnapshot, 'log'>
type LogFn = (type: LogEntry['type'], text: string, highlight?: boolean) => void

const LOG_CAP = 500
const DAY_MS = 24 * 60 * 60 * 1000
const RARE_KEYS: (keyof RareCounts)[] = ['gold', 'emerald', 'lava', 'diamond']

const noRare = (): RareCounts => ({ gold: 0, emerald: 0, lava: 0, diamond: 0 })
const emptySession = (): Session => ({
  startedAt: null,
  catches: 0,
  fishBySpecies: {},
  moneyEarned: 0,
  xpEarned: 0,
  sells: 0,
  captchas: 0,
  commandsSent: 0,
  rareCaught: noRare()
})
const fmt = (n: number): string => Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export class GameState {
  private body: Body = {
    account: {
      balance: null,
      level: null,
      xpToNext: null,
      rod: null,
      biome: null,
      bait: null,
      rare: noRare(),
      totals: {}
    },
    boosts: [],
    quests: [],
    session: emptySession(),
    nextFishAt: null,
    nextDailyAt: null
  }
  private log: LogEntry[] = []
  private nextId = 1
  private sinceSell = 0
  private bait: number | null = null
  private listeners = new Set<PatchCb>()

  constructor(private now: () => number = Date.now) {}

  get catchesSinceSell(): number {
    return this.sinceSell
  }
  get baitEstimate(): number | null {
    return this.bait
  }

  snapshot(): GameSnapshot {
    return { ...structuredClone(this.body), log: this.log.map((l) => ({ ...l })) }
  }

  onPatch(cb: PatchCb): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  apply(e: GameEvent): void {
    this.mutate((b, log) => {
      const s = b.session
      switch (e.kind) {
        case 'catch': {
          for (const i of e.items) {
            s.fishBySpecies[i.name] = (s.fishBySpecies[i.name] ?? 0) + i.count
            s.catches += i.count
            this.sinceSell += i.count
            const lower = i.name.toLowerCase()
            for (const k of RARE_KEYS) if (lower.includes(k)) s.rareCaught[k] += i.count
          }
          if (this.bait !== null) this.bait = Math.max(0, this.bait - 1)
          if (e.xp) s.xpEarned += e.xp
          log('catch', `Pêché : ${e.items.map((i) => `${i.count}× ${i.name}`).join(', ') || 'rien'}`)
          if (e.levelUp !== undefined) {
            b.account.level = e.levelUp
            log('system', `Niveau ${e.levelUp} atteint !`, true)
          }
          break
        }
        case 'sell':
          s.moneyEarned += e.earned
          if (e.xp) s.xpEarned += e.xp
          s.sells++
          this.sinceSell = 0
          log('trade', `Vendu pour ${fmt(e.earned)} $`)
          break
        case 'inventory':
          Object.assign(b.account, {
            balance: e.balance,
            level: e.level,
            xpToNext: e.xpToNext ?? null,
            rod: e.rod ?? null,
            biome: e.biome ?? null,
            bait: e.bait ?? null,
            rare: { ...e.rare }
          })
          this.bait = e.bait ? e.bait.count : null
          break
        case 'stats': {
          const totals: Body['account']['totals'] = { ...e.totals }
          for (const k of ['crates', 'quests', 'trips', 'dailyStreak'] as const) {
            if (e[k] !== undefined) totals[k] = e[k]
          }
          b.account.totals = totals
          break
        }
        case 'boosts':
          b.boosts = e.active.map((x) => ({ ...x }))
          break
        case 'purchase':
          log('trade', `Acheté : ${e.amount}× ${e.item}${e.cost !== undefined ? ` (${fmt(e.cost)} $)` : ''}`)
          break
        case 'daily':
          b.nextDailyAt = this.now() + DAY_MS
          log('trade', `Récompense quotidienne : ${e.reward}`)
          break
        case 'quests':
          b.quests = e.quests.map((q) => ({ ...q }))
          break
        case 'captcha':
          s.captchas++
          log('system', 'Captcha détecté', true)
          break
        case 'captchaSolved':
          log('system', 'Captcha résolu')
          break
        case 'captchaFailed':
          log('system', `Captcha échoué : ${e.text}`)
          break
        case 'error':
          log('error', e.text)
          break
        case 'unknown':
          log('unknown', e.title ? `${e.title} — ${e.text}` : e.text)
          break
        case 'cooldown':
          break
      }
    })
  }

  markCommandSent(_name: string): void {
    this.mutate((b) => {
      b.session.commandsSent++
    })
  }

  markCaptcha(): void {
    this.apply({ kind: 'captcha', text: '' })
  }

  setNextFishAt(ts: number | null): void {
    this.mutate((b) => {
      b.nextFishAt = ts
    })
  }

  startSession(): void {
    this.mutate((b) => {
      b.session = { ...emptySession(), startedAt: this.now() }
      this.sinceSell = 0
    })
  }

  endSession(): SessionSummary {
    const summary: SessionSummary = { ...structuredClone(this.body.session), endedAt: this.now() }
    this.mutate((b) => {
      b.session = emptySession()
    })
    return summary
  }

  private mutate(fn: (b: Body, log: LogFn) => void): void {
    const before = structuredClone(this.body)
    const added: LogEntry[] = []
    fn(this.body, (type, text, highlight) => {
      const entry: LogEntry = { id: this.nextId++, at: this.now(), type, text }
      if (highlight) entry.highlight = true
      added.push(entry)
    })
    if (added.length) this.log = [...this.log, ...added].slice(-LOG_CAP)
    const patch = diff(before, this.body)
    if (Object.keys(patch).length === 0 && added.length === 0) return
    for (const cb of [...this.listeners]) {
      try {
        cb(patch as DeepPartial<GameSnapshot>, added.map((l) => ({ ...l })))
      } catch {
        // a failing listener (UI relay, notification) must neither skip the others nor reach the engine
      }
    }
  }
}

/** Shallow-by-section diff: top-level sections, then one level of fields inside object sections. */
function diff(a: Body, b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(b) as (keyof Body)[]) {
    const x: unknown = a[key]
    const y: unknown = b[key]
    if (isObj(x) && isObj(y)) {
      const sub: Record<string, unknown> = {}
      for (const f of Object.keys(y)) if (!same(x[f], y[f])) sub[f] = structuredClone(y[f])
      if (Object.keys(sub).length) out[key] = sub
    } else if (!same(x, y)) out[key] = structuredClone(y)
  }
  return out
}
