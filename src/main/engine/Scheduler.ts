import type { Config, GameEvent, SlashCommandInfo } from '../../shared/types'
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
  private buyBlockedUntil = { buff: -Infinity, bait: -Infinity }
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
    const cfg = this.getConfig()
    this.pushFish()
    this.loop('profile', () => this.profileTick(), true)
    this.loop('daily', () => this.dailyTick(), true)
    this.loop('quests', () => this.questsTick(), true)
    this.loop('sell', () => this.sellTick(), false, this.sellIntervalMs() ?? POLL_MS)
    if (cfg.buffs.enabled && this.has('boosts')) this.push({ name: 'boosts', priority: 'maintenance', key: 'boosts' })
    this.armBuff('fish', this.buffGraceMs())
    this.armBuff('treasure', this.buffGraceMs())
    this.armWork()
  }

  stop(): void {
    for (const s of this.slots.values()) if (s.handle) clearTimeout(s.handle)
    this.slots.clear()
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
          this.armBuff(type, b ? Math.max(0, b.endsAt - Date.now()) + this.buffGraceMs() : 0)
        }
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

  /** Not enough money: stop buying this kind of item for `ms`. */
  blockPurchases(what: 'buff' | 'bait', ms: number): void {
    this.buyBlockedUntil[what] = Date.now() + ms
  }

  // ---- features -------------------------------------------------------

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
    if (this.runnable('activity')) this.queue.push(c)
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
