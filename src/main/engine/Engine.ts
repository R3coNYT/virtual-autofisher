import type { DiscordClient } from '../discord/DiscordClient'
import type { ConfigStore } from '../config/ConfigStore'
import type { Logger } from '../util/logger'
import { parseMessage } from '../parser'
import { buildText } from '../parser/text'
import type { BotMessage, EngineInfo, EngineState, GameEvent, PauseReason, SessionSummary, SlashCommandInfo } from '../../shared/types'
import { CommandQueue, type QueuedCommand } from './CommandQueue'
import { EditDeduper } from './EditDeduper'
import type { GameState } from './GameState'
import { Scheduler } from './Scheduler'
import { CaptchaFlow } from './captchaFlow'
import { randomBetweenMs } from './humanize'

export type { EngineInfo }
type StateCb = (s: EngineState, info?: EngineInfo) => void
type Target = { guildId: string; channelId: string }

export type EngineDeps = {
  client: DiscordClient
  config: Pick<ConfigStore, 'get'>
  state: GameState
  rand?: () => number
  logger?: Logger
}

const RESPONSE_TIMEOUT_MS = 8_000
const MAX_FAILURES = 3
const NETWORK_GRACE_MS = 2 * 60_000
const RATE_LIMIT_FACTOR = 1.5
const RATE_LIMIT_WINDOW_MS = 5 * 60_000
const NO_FUNDS_BLOCK_MS = 30 * 60_000
const SESSION_CHECK_MS = 15_000
/** A non-fish command answered by "wait N" is re-sent once after N when N is at most this long. */
const DEFER_MAX_MS = 10 * 60_000
const ACTIVE: EngineState[] = ['running', 'paused', 'resting']
/** Graceful stop: data refreshed before halting, each only if the guild exposes the command. */
const GRACEFUL_COMMANDS = ['profile', 'quests']
/** Graceful stop budget (time spent in a captcha not counted). */
const GRACEFUL_MAX_MS = 25_000
/** States a graceful stop can start from (captcha: it starts once the captcha is solved). */
const GRACEFUL_FROM: EngineState[] = ['running', 'paused', 'resting', 'captcha']

type GracefulStop = {
  /** Commands not answered yet (nor timed out). */
  remaining: string[]
  budgetMs: number
  armedAt: number
  timer: ReturnType<typeof setTimeout> | null
  /** Reason shown with the final idle state (session limit). */
  reason?: string
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * State machine driving the fishing session: routes bot messages to GameState and the
 * Scheduler, owns the CommandQueue, and freezes everything on a captcha (see captchaFlow).
 * Never throws out of Discord client callbacks: failures pause the engine.
 */
export class Engine {
  private current: EngineState = 'idle'
  private currentInfo: EngineInfo = {}
  private pauseReason: PauseReason | null = null
  private commands: SlashCommandInfo[] = []
  private target: Target | null = null
  private gen = 0
  private listeners = new Set<StateCb>()
  private sessionEndListeners = new Set<(s: SessionSummary) => void>()
  private readonly queue: CommandQueue
  private readonly scheduler: Scheduler
  private readonly captcha: CaptchaFlow
  private readonly client: DiscordClient
  private readonly gameState: GameState
  private readonly logger: Logger
  private readonly getConfig: EngineDeps['config']['get']
  /** Command whose reply we are waiting for (cleared by the reply or a timeout). */
  private awaiting: QueuedCommand | null = null
  /** Copies pushed by retryOnce: they are not retried again. */
  private retries = new WeakSet<QueuedCommand>()
  /** Copies re-sent after a "wait N" reply: a second cooldown is not deferred again. */
  private deferred = new WeakSet<QueuedCommand>()
  /** Last command handed to Discord (answered or not). */
  private lastSent: QueuedCommand | null = null
  private readonly edits = new EditDeduper()
  private readonly rand: () => number
  private lastMaintenanceKey: string | undefined
  private failures = 0
  private rateLimitUntil = -Infinity
  private sessionActive = false
  private sessionStartedAt = 0
  private networkTimer: ReturnType<typeof setTimeout> | null = null
  private sessionTimer: ReturnType<typeof setInterval> | null = null
  /** Non-null from a graceful stop request until the engine is halted. */
  private graceful: GracefulStop | null = null

  constructor(deps: EngineDeps) {
    this.client = deps.client
    this.gameState = deps.state
    this.logger = deps.logger ?? noopLogger
    this.getConfig = () => deps.config.get()
    const rand = deps.rand ?? Math.random
    this.rand = rand

    this.queue = new CommandQueue((c) => this.send(c), {
      minGapMs: () =>
        this.getConfig().fishing.minGapSec * 1000 * (Date.now() < this.rateLimitUntil ? RATE_LIMIT_FACTOR : 1),
      responseTimeoutMs: RESPONSE_TIMEOUT_MS
    })
    this.queue.onTimeout((c) => this.guard(() => this.onNoAnswer(c, 'timeout')))
    this.queue.onSendError((c, err) => this.guard(() => this.onNoAnswer(c, err)))

    this.scheduler = new Scheduler(this.queue, this.getConfig, this.gameState, {
      rand,
      commands: () => this.commands,
      onRest: (resting) => this.onRest(resting),
      onError: (err) => this.fail(err)
    })

    this.captcha = new CaptchaFlow({
      queue: this.queue,
      scheduler: this.scheduler,
      gameState: this.gameState,
      rand,
      logger: this.logger,
      commands: () => this.commands,
      getState: () => this.current,
      pauseReason: () => this.pauseReason,
      setState: (s, info) => this.setState(s, info),
      activate: () => this.activate(),
      guard: (fn) => this.guard(fn)
    })

    this.client.on('botMessage', (m) => this.onBotMessage(m))
    this.client.on('disconnected', () => this.guard(() => this.onDisconnected()))
    this.client.on('reconnected', () => this.guard(() => this.onReconnected()))
    this.client.on('rateLimited', (ms) => this.guard(() => this.onRateLimited(ms)))
  }

  get state(): EngineState {
    return this.current
  }

  /** Detail of the current state (reason, captcha), as last emitted. */
  get stateInfo(): EngineInfo {
    return { ...this.currentInfo }
  }

  get availableCommands(): SlashCommandInfo[] {
    return this.commands.map((c) => ({ ...c, options: c.options.map((o) => ({ ...o })) }))
  }

  onState(cb: StateCb): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Called with the summary each time a session ends (stop, error, session limit). */
  onSessionEnd(cb: (s: SessionSummary) => void): () => void {
    this.sessionEndListeners.add(cb)
    return () => this.sessionEndListeners.delete(cb)
  }

  async start(target: Target): Promise<void> {
    try {
      if (this.current === 'captcha') {
        // never drop an unsolved captcha by switching channel
        return this.logger.warn('Start refused: a captcha must be solved first')
      }
      if (this.current !== 'idle' && this.current !== 'error') {
        if (this.target?.guildId === target.guildId && this.target.channelId === target.channelId) return
        this.stop()
      }
      const gen = ++this.gen
      this.target = { ...target }
      this.client.setActiveChannel(target.channelId)
      this.setState('connecting')

      let cmds: SlashCommandInfo[]
      try {
        cmds = await this.client.getBotCommands(target.guildId)
      } catch (err) {
        if (gen !== this.gen) return
        this.logger.error('Unable to fetch the Virtual Fisher commands', err)
        return this.toError('Unable to fetch the Virtual Fisher commands')
      }
      if (gen !== this.gen) return // stopped or restarted meanwhile
      this.commands = cmds
      if (!cmds.some((c) => c.name === 'fish')) return this.toError('Command /fish not found in this server')

      this.failures = 0
      this.awaiting = null
      this.gameState.startSession()
      this.sessionActive = true
      this.sessionStartedAt = Date.now()
      this.sessionTimer = setInterval(() => this.guard(() => this.checkSessionLimit()), SESSION_CHECK_MS)

      if (this.state === 'captcha') { // getter: may have changed during the await
        // a captcha arrived while connecting: keep everything frozen and empty
        this.scheduler.start()
        this.queue.clear()
        this.scheduler.freeze()
        this.scheduler.onQueueCleared()
        return
      }
      this.setState('running')
      this.queue.resume()
      this.scheduler.start()
    } catch (err) {
      this.logger.error('Unable to start the engine', err)
      this.toError('Unexpected error while starting')
    }
  }

  pause(reason: PauseReason = 'user'): void {
    if (this.current === 'captcha') {
      // lost connection during a captcha: once solved, wait for the reconnect instead of fishing
      if (reason === 'network' && !this.pauseReason) this.pauseReason = 'network'
      return
    }
    if (this.current === 'paused') {
      if (reason === 'user' && this.pauseReason !== 'user') {
        this.pauseReason = 'user' // a user pause must not be lifted by a reconnect
        this.setState('paused', { reason })
      }
      return
    }
    if (this.current !== 'running' && this.current !== 'resting') return
    this.queue.pause()
    this.scheduler.freeze()
    this.pauseReason = reason
    this.setState('paused', { reason })
  }

  resume(): void {
    if (this.current !== 'paused') return
    this.pauseReason = null
    this.failures = 0
    this.scheduler.thaw()
    this.activate()
  }

  /**
   * Hard stop by default: everything halts now. Graceful: fishing and every timer stop, then
   * /profile and /quests refresh the data (≤ 25 s, no retry) before halting. A stop while a
   * graceful stop is under way always halts at once.
   */
  stop(opts: { graceful?: boolean } = {}): void {
    if (opts.graceful && !this.graceful) return this.stopGracefully()
    this.halt()
    this.setState('idle')
  }

  /** User-typed command. Queued while paused/resting; refused in any other state (captcha included). */
  sendManual(name: string, options?: Record<string, string | number>): void {
    if (!ACTIVE.includes(this.current)) return this.logger.warn(`Command /${name} ignored (state ${this.current})`)
    if (!this.commands.some((c) => c.name === name)) return this.logger.warn(`Command /${name} not found`)
    this.queue.push({ name, options, priority: 'manual' })
  }

  submitCaptcha(answer: string): void {
    this.captcha.submit(answer)
  }

  regenCaptcha(): void {
    this.captcha.regen()
  }

  // ---- Discord events ---------------------------------------------------

  private onBotMessage(m: BotMessage): void {
    if (this.current === 'idle') return
    const ev = parseMessage(m, Date.now())
    let text = ''
    try {
      text = buildText(m)
    } catch {
      /* compared as empty */
    }
    // an edit that changes nothing, or would count a catch/sell/purchase/daily twice, is dropped
    if (!this.edits.accept(m.id, m.isEdit, ev, text)) return
    // Only non-edit messages answer the in-flight command. Known limitation: a late reply
    // to a command that already timed out can release the next command early.
    const replyTo = m.isEdit ? null : this.awaiting
    if (!m.isEdit) {
      this.awaiting = null
      this.failures = 0
    }
    this.guard(() => this.route(ev, replyTo))
    // Settled after routing: a captcha replying to it has already scheduled its re-request.
    if (replyTo) this.guard(() => this.scheduler.onSettled(replyTo))
    // Notified last: a captcha must have paused the queue before it can pump again.
    if (!m.isEdit) this.queue.notifyResponse()
  }

  private route(ev: GameEvent, replyTo: QueuedCommand | null): void {
    if (this.captcha.handle(ev)) return
    // the reply to /use has no known format: logged as is (system), not as an unknown message
    if (replyTo?.name === 'use' && ev.kind === 'unknown') {
      this.gameState.note('system', `/use: ${ev.title ? `${ev.title} — ${ev.text}` : ev.text}`)
    } else this.gameState.apply(ev) // stats/log only: GameState never sends anything
    if (this.graceful) return void (replyTo && this.gracefulSettled(replyTo.name))
    // In captcha (and idle/connecting/error) nothing may trigger a command.
    if (!ACTIVE.includes(this.current)) return
    if (ev.kind === 'error' && /enough/i.test(ev.text)) this.onNoFunds(replyTo)
    if (ev.kind === 'cooldown') this.onCooldown(ev.waitMs, replyTo)
    else this.scheduler.onEvent(ev)
    if (replyTo?.name === 'fish' && ev.kind !== 'catch' && ev.kind !== 'cooldown') this.scheduler.retryFish()
    if (replyTo?.name === 'use') this.scheduler.afterUse()
    // /boosts answered by something else: arm the buffs without endsAt rather than never
    if (replyTo?.key === 'boosts' && ev.kind !== 'boosts') this.scheduler.onCommandFailed(replyTo)
  }

  /**
   * "Wait N": a fish cooldown only when it answers a /fish (or nothing, right after a /fish).
   * Any other command is re-sent once after N (N ≤ 10 min), else its slot is re-armed past N.
   */
  private onCooldown(waitMs: number, replyTo: QueuedCommand | null): void {
    if (replyTo?.name === 'fish' || (!replyTo && this.lastSent?.name === 'fish')) {
      return this.scheduler.onEvent({ kind: 'cooldown', waitMs })
    }
    if (!replyTo || replyTo.priority === 'verify') return
    if (replyTo.name === 'daily') this.gameState.setNextDailyAt(Date.now() + waitMs)
    const wait = formatWait(waitMs)
    if (waitMs <= DEFER_MAX_MS && !this.deferred.has(replyTo)) {
      const again: QueuedCommand = { ...replyTo }
      this.deferred.add(again)
      this.scheduler.deferCommand(again, waitMs + randomBetweenMs(0.2, 1, this.rand))
      return this.logger.info(`/${replyTo.name} on cooldown: sent again in ${wait}`)
    }
    const delay = waitMs + randomBetweenMs(60, 300, this.rand)
    if (this.scheduler.rearm(replyTo.key, delay)) {
      this.logger.info(`/${replyTo.name} on cooldown (${wait}): rescheduled in ${formatWait(delay)}`)
    } else {
      this.logger.info(`/${replyTo.name} on cooldown (${wait}): not sent again`)
    }
  }

  private onNoFunds(replyTo: QueuedCommand | null): void {
    const key = replyTo?.priority === 'maintenance' ? replyTo.key : this.lastMaintenanceKey
    const what = key === 'bait' ? 'bait' : key?.startsWith('buff-') ? 'buff' : null
    if (!what) return
    this.logger.warn(`Not enough money: ${what === 'bait' ? 'bait' : 'boost'} purchases suspended for 30 min`)
    this.scheduler.blockPurchases(what, NO_FUNDS_BLOCK_MS)
  }

  private onNoAnswer(c: QueuedCommand, cause: unknown): void {
    if (this.awaiting === c) this.awaiting = null
    this.scheduler.onSettled(c) // a maintenance retry below is tracked again
    if (this.graceful) {
      // stopping: no retry, move on. In a captcha it stays due and is sent again after the solve.
      if (this.current !== 'captcha') this.gracefulSettled(c.name)
      return
    }
    if (!ACTIVE.includes(this.current)) return
    if (cause !== 'timeout') this.logger.warn(`Unable to send /${c.name}`, cause)
    this.failures++
    this.retryOnce(c)
    if (this.failures >= MAX_FAILURES) {
      this.failures = 0
      this.pause('noResponse')
    }
  }

  /** Spec §7: a command without answer is tried again once (fish via its normal delay). */
  private retryOnce(c: QueuedCommand): void {
    if (c.priority === 'verify') return // a /verify is only ever sent by a user click
    if (c.priority === 'fish') return this.scheduler.retryFish()
    if (this.retries.has(c)) {
      if (c.priority === 'maintenance') this.scheduler.onCommandFailed(c)
      return
    }
    const again: QueuedCommand = { ...c }
    this.retries.add(again)
    if (c.priority === 'maintenance') this.scheduler.pushRetry(again) // tracked: survives a captcha clear
    else this.queue.push(again)
  }

  private onDisconnected(): void {
    if (this.current === 'idle' || this.current === 'error') return
    this.pause('network')
    this.networkTimer ??= setTimeout(
      () => this.guard(() => this.toError('Connection to Discord lost for more than 2 minutes')),
      NETWORK_GRACE_MS
    )
  }

  private onReconnected(): void {
    this.clearNetworkTimer()
    if (this.current === 'captcha' && this.pauseReason === 'network') this.pauseReason = null
    if (this.current === 'paused' && this.pauseReason === 'network') this.resume()
  }

  private onRateLimited(retryAfterMs: number): void {
    this.queue.holdFor(retryAfterMs)
    this.rateLimitUntil = Date.now() + RATE_LIMIT_WINDOW_MS
  }

  private onRest(resting: boolean): void {
    if (resting && this.current === 'running') {
      this.queue.pause()
      this.setState('resting')
    } else if (!resting && this.current === 'resting') {
      this.activate()
    }
  }

  // ---- internals --------------------------------------------------------

  private async send(c: QueuedCommand): Promise<void> {
    const target = this.target
    if (!target) throw new Error('No active channel')
    this.awaiting = c
    this.lastSent = c
    if (c.priority === 'maintenance') this.lastMaintenanceKey = c.key
    this.gameState.markCommandSent(c.name)
    const opts = c.options && Object.keys(c.options).length ? c.options : undefined
    await this.client.sendSlash(target.channelId, c.name, opts)
  }

  /** Back to work after a pause or a captcha: running, or resting if a break is under way. */
  private activate(): void {
    if (this.graceful) return this.continueGracefulStop() // a captcha interrupted the graceful stop
    if (this.scheduler.isResting) {
      this.queue.pause()
      this.setState('resting')
    } else {
      this.setState('running')
      this.queue.resume()
    }
  }

  private checkSessionLimit(): void {
    const h = this.getConfig().sessionLimitH
    if (!this.sessionActive || this.graceful || h <= 0 || Date.now() - this.sessionStartedAt < h * 3_600_000) return
    this.logger.info('Session limit reached, stopping the engine')
    this.stopGracefully('Session limit reached')
  }

  // ---- graceful stop ------------------------------------------------------

  private stopGracefully(reason?: string): void {
    if (this.beginGracefulStop(reason)) return
    this.halt()
    this.setState('idle', reason ? { reason } : {})
  }

  /** False when there is nothing to refresh (no target, no command, not fishing): halt instead. */
  private beginGracefulStop(reason?: string): boolean {
    const st = this.current
    if (!GRACEFUL_FROM.includes(st) || !this.target) return false
    const remaining = GRACEFUL_COMMANDS.filter((n) => this.commands.some((c) => c.name === n))
    if (!remaining.length) return false
    this.scheduler.stop() // /fish and every periodic timer
    if (st !== 'captcha') this.queue.clear() // in a captcha the queue only ever holds the user's /verify
    this.pauseReason = null
    this.graceful = { remaining, budgetMs: GRACEFUL_MAX_MS, armedAt: 0, timer: null, reason }
    this.logger.info('Graceful stop: refreshing the profile and the quests')
    // captcha: nothing is sent until it is solved; activate() then continues the stop
    if (st !== 'captcha') this.continueGracefulStop()
    return true
  }

  /** (Re)sends what is still unanswered and arms the remaining budget. */
  private continueGracefulStop(): void {
    const g = this.graceful
    if (!g) return
    if (!g.remaining.length) return this.finishGracefulStop()
    this.setState('stopping')
    for (const name of g.remaining) {
      // already in flight (e.g. a scheduled /profile): its reply or timeout settles it
      if (this.awaiting?.name !== name) this.queue.push({ name, priority: 'maintenance', key: name })
    }
    this.queue.resume()
    g.armedAt = Date.now()
    g.timer = setTimeout(() => this.guard(() => this.finishGracefulStop()), Math.max(0, g.budgetMs))
  }

  /** A graceful command got its reply or timed out. */
  private gracefulSettled(name: string): void {
    const g = this.graceful
    if (!g) return
    g.remaining = g.remaining.filter((n) => n !== name)
    if (!g.remaining.length && this.current === 'stopping') this.finishGracefulStop()
  }

  /** A captcha interrupts the stop: its budget is frozen until the captcha is solved. */
  private suspendGracefulTimer(): void {
    const g = this.graceful
    if (!g?.timer) return
    clearTimeout(g.timer)
    g.timer = null
    g.budgetMs -= Date.now() - g.armedAt
  }

  private finishGracefulStop(): void {
    const reason = this.graceful?.reason
    this.halt()
    this.setState('idle', reason ? { reason } : {})
  }

  /** Stops every source of commands; the caller sets the resulting state. */
  private halt(): void {
    this.gen++
    if (this.graceful?.timer) clearTimeout(this.graceful.timer)
    this.graceful = null
    this.captcha.reset()
    this.scheduler.stop()
    this.queue.clear()
    this.queue.pause()
    this.queue.notifyResponse() // drop the wait on an in-flight command of the old target
    this.awaiting = null
    this.lastSent = null
    this.pauseReason = null
    this.clearNetworkTimer()
    if (this.sessionTimer) clearInterval(this.sessionTimer)
    this.sessionTimer = null
    if (this.sessionActive) {
      const summary = this.gameState.endSession()
      for (const cb of this.sessionEndListeners) {
        try {
          cb(summary)
        } catch (err) {
          this.logger.error('Session end listener failed', err) // must not re-enter halt()
        }
      }
    }
    this.sessionActive = false
    this.target = null
    this.client.setActiveChannel(null)
  }

  private toError(reason: string): void {
    this.halt()
    this.setState('error', { reason })
  }

  private clearNetworkTimer(): void {
    if (this.networkTimer) clearTimeout(this.networkTimer)
    this.networkTimer = null
  }

  private setState(s: EngineState, info: EngineInfo = {}): void {
    if (s === 'captcha') this.suspendGracefulTimer()
    this.current = s
    this.currentInfo = { ...info }
    for (const cb of [...this.listeners]) {
      try {
        cb(s, info)
      } catch (err) {
        this.logger.error('State listener failed', err)
      }
    }
  }

  private guard(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.fail(err)
    }
  }

  private fail(err: unknown): void {
    this.logger.error('Unexpected error in the engine', err)
    try {
      this.pause('exception')
    } catch (e) {
      this.logger.error('Unable to pause', e)
    }
  }
}

function formatWait(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
