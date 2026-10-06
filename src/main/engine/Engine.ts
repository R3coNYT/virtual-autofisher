import type { DiscordClient } from '../discord/DiscordClient'
import type { ConfigStore } from '../config/ConfigStore'
import type { Logger } from '../util/logger'
import { parseMessage } from '../parser'
import type { BotMessage, EngineState, GameEvent, PauseReason, SlashCommandInfo } from '../../shared/types'
import { CommandQueue, type QueuedCommand } from './CommandQueue'
import type { GameState } from './GameState'
import { Scheduler } from './Scheduler'
import { CaptchaFlow } from './captchaFlow'

export type EngineInfo = { reason?: string; captchaImageUrl?: string; captchaText?: string }
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
const ACTIVE: EngineState[] = ['running', 'paused', 'resting']

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * State machine driving the fishing session: routes bot messages to GameState and the
 * Scheduler, owns the CommandQueue, and freezes everything on a captcha (see captchaFlow).
 * Never throws out of Discord client callbacks: failures pause the engine.
 */
export class Engine {
  private current: EngineState = 'idle'
  private pauseReason: PauseReason | null = null
  private commands: SlashCommandInfo[] = []
  private target: Target | null = null
  private gen = 0
  private listeners = new Set<StateCb>()
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
  private lastMaintenanceKey: string | undefined
  private failures = 0
  private rateLimitUntil = -Infinity
  private sessionActive = false
  private sessionStartedAt = 0
  private networkTimer: ReturnType<typeof setTimeout> | null = null
  private sessionTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: EngineDeps) {
    this.client = deps.client
    this.gameState = deps.state
    this.logger = deps.logger ?? noopLogger
    this.getConfig = () => deps.config.get()
    const rand = deps.rand ?? Math.random

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

  get availableCommands(): SlashCommandInfo[] {
    return this.commands.map((c) => ({ ...c, options: c.options.map((o) => ({ ...o })) }))
  }

  onState(cb: StateCb): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async start(target: Target): Promise<void> {
    try {
      if (this.current === 'captcha') {
        // never drop an unsolved captcha by switching channel
        return this.logger.warn('Démarrage refusé : un captcha doit être résolu')
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
        this.logger.error('Récupération des commandes Virtual Fisher impossible', err)
        return this.toError('Impossible de récupérer les commandes de Virtual Fisher')
      }
      if (gen !== this.gen) return // stopped or restarted meanwhile
      this.commands = cmds
      if (!cmds.some((c) => c.name === 'fish')) return this.toError('Commande /fish introuvable dans ce serveur')

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
      this.logger.error('Démarrage du moteur impossible', err)
      this.toError('Erreur inattendue au démarrage')
    }
  }

  pause(reason: PauseReason = 'user'): void {
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

  stop(): void {
    this.halt()
    this.setState('idle')
  }

  /** User-typed command. Queued while paused/resting; refused in any other state (captcha included). */
  sendManual(name: string, options?: Record<string, string | number>): void {
    if (!ACTIVE.includes(this.current)) return this.logger.warn(`Commande /${name} ignorée (état ${this.current})`)
    if (!this.commands.some((c) => c.name === name)) return this.logger.warn(`Commande /${name} introuvable`)
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
    // Only non-edit messages answer the in-flight command. Known limitation: a late reply
    // to a command that already timed out can release the next command early.
    const replyTo = m.isEdit ? null : this.awaiting
    if (!m.isEdit) {
      this.awaiting = null
      this.failures = 0
    }
    this.guard(() => this.route(parseMessage(m, Date.now()), replyTo))
    // Notified last: a captcha must have paused the queue before it can pump again.
    if (!m.isEdit) this.queue.notifyResponse()
  }

  private route(ev: GameEvent, replyTo: QueuedCommand | null): void {
    if (this.captcha.handle(ev)) return
    this.gameState.apply(ev) // stats/log only: GameState never sends anything
    // In captcha (and idle/connecting/error) nothing may trigger a command.
    if (!ACTIVE.includes(this.current)) return
    if (ev.kind === 'error' && /enough/i.test(ev.text)) this.onNoFunds(replyTo)
    this.scheduler.onEvent(ev)
    if (replyTo?.name === 'fish' && ev.kind !== 'catch' && ev.kind !== 'cooldown') this.scheduler.retryFish()
  }

  private onNoFunds(replyTo: QueuedCommand | null): void {
    const key = replyTo?.priority === 'maintenance' ? replyTo.key : this.lastMaintenanceKey
    const what = key === 'bait' ? 'bait' : key?.startsWith('buff-') ? 'buff' : null
    if (!what) return
    this.logger.warn(`Fonds insuffisants : achats ${what === 'bait' ? "d'appât" : 'de boosts'} suspendus 30 min`)
    this.scheduler.blockPurchases(what, NO_FUNDS_BLOCK_MS)
  }

  private onNoAnswer(c: QueuedCommand, cause: unknown): void {
    if (this.awaiting === c) this.awaiting = null
    if (!ACTIVE.includes(this.current)) return
    if (cause !== 'timeout') this.logger.warn(`Envoi de /${c.name} impossible`, cause)
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
    this.queue.push(again)
  }

  private onDisconnected(): void {
    if (this.current === 'idle' || this.current === 'error') return
    this.pause('network')
    this.networkTimer ??= setTimeout(
      () => this.guard(() => this.toError('Connexion à Discord perdue depuis plus de 2 minutes')),
      NETWORK_GRACE_MS
    )
  }

  private onReconnected(): void {
    this.clearNetworkTimer()
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
    if (!target) throw new Error('Aucun salon actif')
    this.awaiting = c
    if (c.priority === 'maintenance') this.lastMaintenanceKey = c.key
    this.scheduler.onSent(c)
    this.gameState.markCommandSent(c.name)
    const opts = c.options && Object.keys(c.options).length ? c.options : undefined
    await this.client.sendSlash(target.channelId, c.name, opts)
  }

  /** Back to work after a pause or a captcha: running, or resting if a break is under way. */
  private activate(): void {
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
    if (!this.sessionActive || h <= 0 || Date.now() - this.sessionStartedAt < h * 3_600_000) return
    this.logger.info('Limite de session atteinte, arrêt du moteur')
    this.halt()
    this.setState('idle', { reason: 'Limite de session atteinte' })
  }

  /** Stops every source of commands; the caller sets the resulting state. */
  private halt(): void {
    this.gen++
    this.captcha.reset()
    this.scheduler.stop()
    this.queue.clear()
    this.queue.pause()
    this.queue.notifyResponse() // drop the wait on an in-flight command of the old target
    this.awaiting = null
    this.pauseReason = null
    this.clearNetworkTimer()
    if (this.sessionTimer) clearInterval(this.sessionTimer)
    this.sessionTimer = null
    if (this.sessionActive) this.gameState.endSession()
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
    this.current = s
    for (const cb of [...this.listeners]) {
      try {
        cb(s, info)
      } catch (err) {
        this.logger.error("Erreur dans un écouteur d'état", err)
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
    this.logger.error('Erreur inattendue dans le moteur', err)
    try {
      this.pause('exception')
    } catch (e) {
      this.logger.error('Mise en pause impossible', e)
    }
  }
}
