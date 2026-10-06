import type { EngineInfo, EngineState, GameEvent, PauseReason, SlashCommandInfo } from '../../shared/types'
import type { Logger } from '../util/logger'
import type { CommandQueue } from './CommandQueue'
import type { GameState } from './GameState'
import type { Scheduler } from './Scheduler'
import { positionalOptions } from './Scheduler'
import { randomBetweenMs } from './humanize'

type Info = Pick<EngineInfo, 'captchaImageUrl' | 'captchaText' | 'captchaSolved'>

export const CAPTCHA_SOLVED_TEXT = 'Captcha solved — resuming in a few seconds…'

export type CaptchaDeps = {
  queue: CommandQueue
  scheduler: Scheduler
  gameState: GameState
  rand: () => number
  logger: Logger
  commands: () => SlashCommandInfo[]
  getState: () => EngineState
  /** Non-null when the engine must go back to paused after the captcha (user pause, network). */
  pauseReason: () => PauseReason | null
  setState: (s: EngineState, info?: EngineInfo) => void
  /**
   * Leaves the captcha (scheduler already thawed): running or resting, queue resumed accordingly,
   * or back to 'stopping' when a graceful stop was under way.
   */
  activate: () => void
  /** Leaves a captcha that arrived without a session (idle/error): back to idle, nothing resumes. */
  backToIdle: () => void
  guard: (fn: () => void) => void
}

/** States in which a captcha takes over the engine (idle/error: a reply to a manual command). */
const WATCHED: EngineState[] = ['idle', 'error', 'connecting', 'running', 'paused', 'resting', 'stopping', 'captcha']
/** Pre-captcha states without a session: the solve goes back to idle, never to fishing. */
const SESSIONLESS: EngineState[] = ['idle', 'error']

/**
 * Captcha safety. On a captcha the queue is emptied and paused and the scheduler frozen;
 * the only command that can leave is a 'verify' pushed by an explicit user action
 * (submit/regen). Nothing here ever sends /verify on its own.
 */
export class CaptchaFlow {
  private info: Info = {}
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  /** State the engine was in when the captcha arrived. */
  private from: EngineState | null = null

  constructor(private readonly d: CaptchaDeps) {}

  /** Returns true when the event is captcha-related (it is then fully handled here). */
  handle(ev: GameEvent): boolean {
    switch (ev.kind) {
      case 'captcha':
        this.enter(ev)
        return true
      case 'captchaSolved':
        this.d.gameState.apply(ev)
        if (this.d.getState() === 'captcha') {
          this.scheduleResume()
          this.info = { ...this.info, captchaText: CAPTCHA_SOLVED_TEXT, captchaSolved: true }
          this.d.setState('captcha', { ...this.info })
        }
        return true
      case 'captchaFailed':
        this.d.gameState.apply(ev)
        if (this.d.getState() === 'captcha') {
          this.cancelResume()
          this.info = { captchaImageUrl: this.info.captchaImageUrl, captchaText: ev.text }
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
    this.from = null
  }

  private enter(ev: Extract<GameEvent, { kind: 'captcha' }>): void {
    const st = this.d.getState()
    if (!WATCHED.includes(st)) {
      this.d.logger.warn(`Captcha received in state ${st}, ignored`)
      return
    }
    // Safety first: nothing queued survives, nothing new gets in.
    this.d.queue.clear()
    this.d.queue.pause()
    this.d.scheduler.freeze()
    this.d.scheduler.onQueueCleared() // dropped maintenance is re-requested after the thaw
    this.cancelResume()
    if (st !== 'captcha') {
      this.from = st
      this.d.gameState.apply(ev) // counts the captcha once, not on each update
    }
    this.info = { captchaImageUrl: ev.imageUrl ?? this.info.captchaImageUrl, captchaText: ev.text }
    this.d.setState('captcha', { ...this.info })
  }

  private pushVerify(answer: string): void {
    if (this.d.getState() !== 'captcha' || this.info.captchaSolved) return
    const verify = this.d.commands().find((c) => c.name === 'verify')
    if (!verify) return this.d.logger.warn('Command /verify not found in this server')
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
          const from = this.from
          this.from = null
          // no session to resume: queue stays paused (until the next manual command), scheduler stopped
          if (from && SESSIONLESS.includes(from)) return this.d.backToIdle()
          const reason = this.d.pauseReason()
          // paused before (or, for the network, during) the captcha: stay paused, scheduler frozen
          if (reason) return this.d.setState('paused', { reason })
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
