import type { EngineState, GameEvent, SlashCommandInfo } from '../../shared/types'
import type { Logger } from '../util/logger'
import type { CommandQueue } from './CommandQueue'
import type { GameState } from './GameState'
import type { Scheduler } from './Scheduler'
import { positionalOptions } from './Scheduler'
import { randomBetweenMs } from './humanize'

type Info = { captchaImageUrl?: string; captchaText?: string }

export type CaptchaDeps = {
  queue: CommandQueue
  scheduler: Scheduler
  gameState: GameState
  rand: () => number
  logger: Logger
  commands: () => SlashCommandInfo[]
  getState: () => EngineState
  setState: (s: EngineState, info?: Info) => void
  /** Leaves the captcha (scheduler already thawed): running or resting, queue resumed accordingly. */
  activate: () => void
  guard: (fn: () => void) => void
}

/** States in which a captcha takes over the engine. In idle/error nothing is being sent anyway. */
const WATCHED: EngineState[] = ['connecting', 'running', 'paused', 'resting', 'captcha']

/**
 * Captcha safety. On a captcha the queue is emptied and paused and the scheduler frozen;
 * the only command that can leave is a 'verify' pushed by an explicit user action
 * (submit/regen). Nothing here ever sends /verify on its own.
 */
export class CaptchaFlow {
  private info: Info = {}
  private resumeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly d: CaptchaDeps) {}

  /** Returns true when the event is captcha-related (it is then fully handled here). */
  handle(ev: GameEvent): boolean {
    switch (ev.kind) {
      case 'captcha':
        this.enter(ev)
        return true
      case 'captchaSolved':
        this.d.gameState.apply(ev)
        if (this.d.getState() === 'captcha') this.scheduleResume()
        return true
      case 'captchaFailed':
        this.d.gameState.apply(ev)
        if (this.d.getState() === 'captcha') {
          this.cancelResume()
          this.info = { ...this.info, captchaText: ev.text }
          this.d.setState('captcha', { ...this.info })
        }
        return true
      default:
        return false
    }
  }

  submit(answer: string): void {
    const a = answer.trim()
    if (a) this.pushVerify(a)
  }

  regen(): void {
    this.pushVerify('regen')
  }

  /** Forget any pending resume (engine halted). */
  reset(): void {
    this.cancelResume()
    this.info = {}
  }

  private enter(ev: Extract<GameEvent, { kind: 'captcha' }>): void {
    const st = this.d.getState()
    if (!WATCHED.includes(st)) {
      this.d.logger.warn(`Captcha reçu dans l'état ${st}, ignoré`)
      return
    }
    // Safety first: nothing queued survives, nothing new gets in.
    this.d.queue.clear()
    this.d.queue.pause()
    this.d.scheduler.freeze()
    this.d.scheduler.onQueueCleared() // dropped maintenance is re-requested after the thaw
    this.cancelResume()
    if (st !== 'captcha') this.d.gameState.apply(ev) // counts the captcha once, not on each update
    this.info = { captchaImageUrl: ev.imageUrl ?? this.info.captchaImageUrl, captchaText: ev.text }
    this.d.setState('captcha', { ...this.info })
  }

  private pushVerify(answer: string): void {
    if (this.d.getState() !== 'captcha') return
    const verify = this.d.commands().find((c) => c.name === 'verify')
    if (!verify) return this.d.logger.warn('Commande /verify introuvable dans ce serveur')
    this.d.queue.push({ name: 'verify', options: positionalOptions(verify, [answer]), priority: 'verify', key: 'verify' })
  }

  private scheduleResume(): void {
    if (this.resumeTimer) return
    this.resumeTimer = setTimeout(
      () =>
        this.d.guard(() => {
          this.resumeTimer = null
          if (this.d.getState() !== 'captcha') return
          this.info = {}
          this.d.scheduler.thaw()
          this.d.activate()
        }),
      randomBetweenMs(5, 15, this.d.rand)
    )
  }

  private cancelResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }
}
