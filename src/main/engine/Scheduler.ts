import { boosterUseOptions } from '../../shared/boosters'
import type { Boost, Config, GameEvent, SlashCommandInfo } from '../../shared/types'
import type { CommandQueue, QueuedCommand } from './CommandQueue'
import type { GameState } from './GameState'
import { fishDelayMs, randomBetweenMs } from './humanize'

type Kind = 'activity' | 'rest'
type Slot = { fn: () => void; remaining: number; armedAt: number; handle: ReturnType<typeof setTimeout> | null; kind: Kind }

export type SchedulerHooks = {
  rand?: () => number
  /** Commands Virtual Fisher exposes in the active guild; missing ones are skipped. */
  commands?: () => SlashCommandInfo[]
  /** A human break starts (true) or ends (false). */
  onRest?: (resting: boolean) => void
  /** An exception escaped a timer callback. */
  onError?: (err: unknown) => void
}

const MIN = 60_000
const POLL_MS = MIN // re-check interval for a disabled feature (config hot reload)
const DAILY_MS = 24 * 60 * MIN
const QUESTS_MS = 30 * MIN
const BAIT_LOW = 3 // estimated bait left below which we buy more

/** SlashOptions keyed by the command's real option names, filled positionally. */
export function positionalOptions(info: SlashCommandInfo, values: (string | number)[]): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  info.options.forEach((o, i) => {
    if (i < values.length) out[o.name] = values[i]
  })
  return out
}

/**
 * Owns every timer that feeds the CommandQueue (fish, sell, buffs, bait, profile,
 * daily, quests, breaks). freeze()/thaw() suspend them with their remaining time;
 * while frozen or resting nothing is pushed. Config is re-read at every decision.
 */
export class Scheduler {
  private slots = new Map<string, Slot>()
  private running = false
  private frozen = false
  private resting = false
  /** Maintenance commands pushed and not yet answered (queued or in flight), by dedupe key. */
  private pending = new Map<string, QueuedCommand>()
  private buyBlockedUntil = { buff: -Infinity, bait: -Infinity }
  /** End of the active personal boost (last /boosts), null when none. */
  private personalEndsAt: number | null = null
  /** /boosters already asked since the last time a personal boost was seen active. */
  private boostersChecked = false
  /** /use already sent since the last time a personal boost was seen active (one per expiry). */
  private boosterUsed = false
  /** /boosters said 0: no more checks until the next session. */
  private boostersExhausted = false
  private readonly rand: () => number

  constructor(
    private readonly queue: CommandQueue,
    private readonly getConfig: () => Config,
    private readonly state: GameState,
    private readonly hooks: SchedulerHooks = {}
  ) {
    this.rand = hooks.rand ?? Math.random
  }

  get isResting(): boolean {
    return this.resting
  }

  start(): void {
    this.stop()
    this.running = true
    this.personalEndsAt = null
    this.boostersChecked = this.boosterUsed = this.boostersExhausted = false
    const cfg = this.getConfig()
    // data first (/profile, /boosts, daily, quests), then the first /fish: maintenance outranks fish
    this.loop('profile', () => this.profileTick(), true)
    if (this.has('boosts')) {
      // always refreshed at start; buff timers are armed from its reply (endsAt), or by onCommandFailed
      this.pushBoosts()
      if (!cfg.buffs.enabled) this.armBuffs(POLL_MS)
    } else {
      this.armBuffs(cfg.buffs.enabled ? this.buffGraceMs() : POLL_MS)
    }
    this.loop('daily', () => this.dailyTick(), true)
    this.loop('quests', () => this.questsTick(), true)
    this.loop('sell', () => this.sellTick(), false, this.sellIntervalMs() ?? POLL_MS)
    this.pushFish()
    this.armWork()
  }

  stop(): void {
    for (const s of this.slots.values()) if (s.handle) clearTimeout(s.handle)
    this.slots.clear()
    this.pending.clear()
    this.running = this.frozen = this.resting = false
    this.state.setNextFishAt(null)
  }

  freeze(): void {
    this.frozen = true
    this.syncAll()
  }

  thaw(): void {
    this.frozen = false
    this.syncAll()
    this.ensureFish()
  }

  onEvent(e: GameEvent): void {
    if (!this.running) return
    const cfg = this.getConfig()
    switch (e.kind) {
      case 'catch':
        this.fishAfter(fishDelayMs(cfg.fishing, this.rand))
        if (cfg.sell.enabled && cfg.sell.mode === 'catches' && this.state.catchesSinceSell >= cfg.sell.every) this.pushSell()
        this.maybeBait(false)
        // a quest just completed: refresh the quest list now rather than at the next 30 min tick
        if (e.questsCompleted?.length && this.has('quests')) {
          this.push({ name: 'quests', priority: 'maintenance', key: 'quests' })
        }
        break
      case 'cooldown':
        this.fishAfter(e.waitMs + randomBetweenMs(0.2, 1, this.rand))
        break
      case 'sell':
        this.pushProfile()
        break
      case 'inventory':
        this.maybeBait(true)
        break
      case 'boosts':
        for (const type of ['fish', 'treasure'] as const) {
          const b = e.active.find((x) => buffType(x.name) === type)
          this.armBuff(type, (b ? Math.max(0, b.endsAt - Date.now()) : 0) + this.buffGraceMs())
        }
        this.onBoosts(e.active)
        break
      case 'boosters':
        this.onBoosters(e.personal)
        break
      case 'purchase': {
        const type = buffType(e.item)
        if (type) this.armBuff(type, cfg.buffs.lengthMin * MIN + this.buffGraceMs())
        else this.pushProfile() // bait bought: refresh the estimate from the inventory
        break
      }
    }
  }

  /** The /fish got no usable answer (timeout, error, unknown): try again after a normal delay. */
  retryFish(): void {
    if (this.running) this.fishAfter(fishDelayMs(this.getConfig().fishing, this.rand))
  }

  /** The command got its reply, or failed: it no longer needs re-requesting after a captcha. */
  onSettled(c: QueuedCommand): void {
    if (c.key !== undefined && this.pending.get(c.key) === c) this.pending.delete(c.key)
  }

  /** Engine retry of a timed-out maintenance command: queued and tracked like any other. */
  pushRetry(c: QueuedCommand): void {
    if (!this.running || !this.queue.push(c)) return
    if (c.key !== undefined) this.pending.set(c.key, c)
  }

  /** A maintenance command got no usable answer (none after its retry, or not the expected kind). */
  onCommandFailed(c: QueuedCommand): void {
    if (this.running && c.key === 'boosts') this.armBuffs(this.buffGraceMs()) // fallback without endsAt
  }

  /**
   * The queue was emptied (captcha): every maintenance command still waiting in it, or in
   * flight without a reply yet, is requested again 5–30 s after the scheduler thaws (the timers are frozen until then).
   */
  onQueueCleared(): void {
    for (const [key, cmd] of this.pending) {
      this.set(`redo-${key}`, this.buffGraceMs(), () => {
        const what = key === 'bait' ? 'bait' : key.startsWith('buff-') ? 'buff' : null
        if (what && Date.now() < this.buyBlockedUntil[what]) return
        this.push(cmd)
      })
    }
    this.pending.clear()
  }

  /** A command answered by a short "wait N": pushed again after `ms` (timer frozen like the others). */
  deferCommand(c: QueuedCommand, ms: number): void {
    if (this.running) this.set(`defer-${c.key ?? c.name}`, ms, () => this.push(c))
  }

  /**
   * A maintenance command answered by a long "wait N" (e.g. daily): its periodic timer
   * (daily, quests, profile, sell, buff-*) fires next in `ms`. False when it has none.
   */
  rearm(key: string | undefined, ms: number): boolean {
    const slot = key === undefined ? undefined : this.slots.get(key)
    if (!this.running || !slot || key === undefined) return false
    this.set(key, ms, slot.fn, slot.kind)
    return true
  }

  /** /use got its reply (whatever it says): refresh the active boosts. */
  afterUse(): void {
    if (this.running) this.pushBoosts()
  }

  /** Not enough money: stop buying this kind of item for `ms`. */
  blockPurchases(what: 'buff' | 'bait', ms: number): void {
    this.buyBlockedUntil[what] = Date.now() + ms
  }

  // ---- features -------------------------------------------------------

  private pushBoosts(): void {
    if (this.has('boosts')) this.push({ name: 'boosts', priority: 'maintenance', key: 'boosts' })
  }

  /**
   * /boosts reply: re-asks /boosts once the next boost ends, and (opt-in) starts the personal
   * booster check when none is active. A personal boost seen active opens a new check cycle.
   */
  private onBoosts(active: Boost[]): void {
    const now = Date.now()
    const live = active.filter((b) => b.endsAt > now)
    const personal = live.find((b) => b.name === 'Personal')
    this.personalEndsAt = personal?.endsAt ?? null
    if (personal) this.boostersChecked = this.boosterUsed = false
    if (live.length) {
      const next = Math.min(...live.map((b) => b.endsAt))
      this.set('boosts-expiry', next - now + randomBetweenMs(2, 10, this.rand), () => this.pushBoosts())
    } else this.clearSlot('boosts-expiry')
    if (personal || this.boostersChecked || this.boostersExhausted) return
    if (!this.getConfig().boosters.autoPersonal || !this.has('boosters')) return
    this.boostersChecked = true
    this.push({ name: 'boosters', priority: 'maintenance', key: 'boosters' })
  }

  /** /boosters reply: activates one personal booster when allowed (at most one /use per expiry). */
  private onBoosters(owned: number): void {
    if (owned <= 0) {
      this.boostersExhausted = true
      return
    }
    if (!this.getConfig().boosters.autoPersonal || this.boosterUsed) return
    if (this.personalEndsAt !== null && this.personalEndsAt > Date.now()) return
    const options = boosterUseOptions(this.info('use'), 'personal')
    if (!options) return
    this.boosterUsed = true
    this.push({ name: 'use', options, priority: 'maintenance', key: 'use' })
  }

  private fishAfter(ms: number): void {
    this.state.setNextFishAt(Date.now() + ms)
    this.set('fish', ms, () => this.pushFish())
  }

  private pushFish(): void {
    this.push({ name: 'fish', priority: 'fish', key: 'fish' })
  }

  private ensureFish(): void {
    if (this.running && !this.slots.has('fish')) this.retryFish()
  }

  private pushSell(): void {
    const info = this.info('sell')
    if (info) this.push({ name: 'sell', options: positionalOptions(info, ['all']), priority: 'maintenance', key: 'sell' })
  }

  private pushProfile(): void {
    if (this.has('profile')) this.push({ name: 'profile', priority: 'maintenance', key: 'profile' })
    if (this.has('stats')) this.push({ name: 'stats', priority: 'maintenance', key: 'stats' })
  }

  private profileTick(): number | null {
    const m = this.getConfig().profile.refreshMin
    if (m <= 0) return null
    this.pushProfile()
    return m * MIN
  }

  private dailyTick(): number | null {
    if (!this.getConfig().daily.enabled || !this.has('daily')) return null
    this.push({ name: 'daily', priority: 'maintenance', key: 'daily' })
    return DAILY_MS + randomBetweenMs(2 * 60, 10 * 60, this.rand)
  }

  private questsTick(): number | null {
    if (!this.getConfig().quests.enabled || !this.has('quests')) return null
    this.push({ name: 'quests', priority: 'maintenance', key: 'quests' })
    return QUESTS_MS
  }

  private sellIntervalMs(): number | null {
    const s = this.getConfig().sell
    return s.enabled && s.mode === 'minutes' && s.every > 0 ? s.every * MIN : null
  }

  private sellTick(): number | null {
    const every = this.sellIntervalMs()
    if (every !== null && this.state.catchesSinceSell > 0) this.pushSell()
    return every
  }

  private buffGraceMs(): number {
    return randomBetweenMs(5, 30, this.rand)
  }

  private armBuffs(ms: number): void {
    this.armBuff('fish', ms)
    this.armBuff('treasure', ms)
  }

  private armBuff(type: 'fish' | 'treasure', ms: number): void {
    this.set(`buff-${type}`, ms, () => this.buffTick(type))
  }

  private buffTick(type: 'fish' | 'treasure'): void {
    const cfg = this.getConfig()
    const blockedFor = this.buyBlockedUntil.buff - Date.now()
    const buy = this.info('buy')
    if (!cfg.buffs.enabled || !buy) return this.armBuff(type, POLL_MS)
    if (blockedFor > 0) return this.armBuff(type, blockedFor)
    this.push({
      name: 'buy',
      options: positionalOptions(buy, [`${type}${cfg.buffs.lengthMin}m`, 1]),
      priority: 'maintenance',
      key: `buff-${type}`
    })
    if (type === 'fish') this.pushBait()
    // fallback if the purchase reply is not recognised; a 'purchase' event re-arms it
    this.armBuff(type, cfg.buffs.lengthMin * MIN + this.buffGraceMs())
  }

  private maybeBait(unknownIsLow: boolean): void {
    const est = this.state.baitEstimate
    if (est === null ? unknownIsLow : est < BAIT_LOW) this.pushBait()
  }

  private pushBait(): void {
    const cfg = this.getConfig()
    const buy = this.info('buy')
    if (!cfg.bait.enabled || !cfg.bait.name || !buy || Date.now() < this.buyBlockedUntil.bait) return
    const amount = cfg.bait.autoAmount
      ? Math.max(1, Math.ceil(((cfg.buffs.lengthMin * 60) / cfg.fishing.baseCooldownSec - 10) * 0.75))
      : cfg.bait.amount
    if (amount <= 0) return
    this.push({ name: 'buy', options: positionalOptions(buy, [cfg.bait.name, amount]), priority: 'maintenance', key: 'bait' })
  }

  private armWork(): void {
    const b = this.getConfig().breaks
    if (!b.enabled) return this.set('work', POLL_MS, () => this.armWork())
    const ms = Math.max(MIN, randomBetweenMs((b.workMin - b.workJitterMin) * 60, (b.workMin + b.workJitterMin) * 60, this.rand))
    this.set('work', ms, () => this.startRest())
  }

  private startRest(): void {
    const b = this.getConfig().breaks
    if (!b.enabled) return this.armWork()
    this.resting = true
    this.syncAll()
    this.hooks.onRest?.(true)
    const ms = Math.max(MIN, randomBetweenMs((b.restMin - b.restJitterMin) * 60, (b.restMin + b.restJitterMin) * 60, this.rand))
    this.set('rest', ms, () => this.endRest(), 'rest')
  }

  private endRest(): void {
    this.resting = false
    this.syncAll()
    this.hooks.onRest?.(false)
    this.armWork()
    this.ensureFish()
  }

  // ---- plumbing -------------------------------------------------------

  private info(name: string): SlashCommandInfo | undefined {
    return this.hooks.commands?.().find((c) => c.name === name)
  }

  private has(name: string): boolean {
    return this.info(name) !== undefined
  }

  /** Pushes only while actively fishing: never while frozen (pause/captcha) or resting. */
  private push(c: QueuedCommand): void {
    if (!this.runnable('activity') || !this.queue.push(c)) return
    if (c.priority === 'maintenance' && c.key !== undefined) this.pending.set(c.key, c)
  }

  /** Runs `tick` now (or after `firstDelay`) and re-arms with its returned delay, POLL_MS when disabled. */
  private loop(name: string, tick: () => number | null, runNow: boolean, firstDelay = 0): void {
    const run = (): void => {
      let next = POLL_MS
      try {
        next = tick() ?? POLL_MS
      } finally {
        this.set(name, next, run) // keeps looping even if tick() threw
      }
    }
    if (runNow) run()
    else this.set(name, firstDelay, run)
  }

  private runnable(kind: Kind): boolean {
    return this.running && !this.frozen && (kind === 'rest' || !this.resting)
  }

  private set(name: string, ms: number, fn: () => void, kind: Kind = 'activity'): void {
    const old = this.slots.get(name)
    if (old?.handle) clearTimeout(old.handle)
    const slot: Slot = { fn, remaining: Math.max(0, ms), armedAt: 0, handle: null, kind }
    this.slots.set(name, slot)
    this.sync(name, slot)
  }

  private clearSlot(name: string): void {
    const slot = this.slots.get(name)
    if (slot?.handle) clearTimeout(slot.handle)
    this.slots.delete(name)
  }

  private syncAll(): void {
    for (const [name, slot] of [...this.slots]) this.sync(name, slot)
  }

  /** Arms or suspends one timer according to the current running/frozen/resting flags. */
  private sync(name: string, s: Slot): void {
    const want = this.runnable(s.kind)
    if (want && !s.handle) {
      s.armedAt = Date.now()
      s.handle = setTimeout(() => {
        if (this.slots.get(name) !== s) return
        this.slots.delete(name)
        try {
          s.fn()
        } catch (err) {
          this.hooks.onError?.(err)
        }
      }, s.remaining)
    } else if (!want && s.handle) {
      clearTimeout(s.handle)
      s.handle = null
      s.remaining = Math.max(0, s.remaining - (Date.now() - s.armedAt))
    }
  }
}

function buffType(name: string): 'fish' | 'treasure' | null {
  if (/treasure/i.test(name)) return 'treasure'
  if (/fish/i.test(name) && /boost|\d+\s*m\b/i.test(name)) return 'fish'
  return null
}
