export type Priority = 'manual' | 'verify' | 'maintenance' | 'fish'

export type QueuedCommand = {
  name: string
  options?: Record<string, string | number>
  priority: Priority
  key?: string
}

type Opts = { minGapMs: () => number; responseTimeoutMs: number }
type Entry = { cmd: QueuedCommand; seq: number }

const RANK: Record<Priority, number> = { manual: 0, verify: 1, maintenance: 2, fish: 3 }

/**
 * Single serialized channel for slash commands: one command in flight at a time,
 * released by notifyResponse() or the response timeout, never closer than
 * minGapMs() to the previous send.
 */
export class CommandQueue {
  private items: Entry[] = []
  private seq = 0
  private inFlight: { cmd: QueuedCommand; id: number } | null = null
  private flightId = 0
  private lastSendAt = -Infinity
  private holdUntil = -Infinity
  private paused = false
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private timeoutCb: (c: QueuedCommand) => void = () => {}
  private sendErrorCb: (c: QueuedCommand, err: unknown) => void = () => {}

  constructor(
    private readonly send: (c: QueuedCommand) => Promise<void>,
    private readonly opts: Opts
  ) {}

  get size(): number {
    return this.items.length
  }

  /** Returns false when a command with the same key is already queued. */
  push(c: QueuedCommand): boolean {
    if (c.key !== undefined && this.items.some((e) => e.cmd.key === c.key)) return false
    this.items.push({ cmd: c, seq: this.seq++ })
    this.pump()
    return true
  }

  clear(): void {
    this.items = []
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.pump()
  }

  /** Nothing is sent until `ms` have elapsed (e.g. Discord 429 retry_after). */
  holdFor(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, Date.now() + ms)
    this.pump()
  }

  /** The bot answered the in-flight command. No-op if nothing is in flight. */
  notifyResponse(): void {
    if (!this.inFlight) return
    this.release()
    this.pump()
  }

  onTimeout(cb: (c: QueuedCommand) => void): void {
    this.timeoutCb = cb
  }

  onSendError(cb: (c: QueuedCommand, err: unknown) => void): void {
    this.sendErrorCb = cb
  }

  private release(): void {
    this.inFlight = null
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = null
  }

  /** Best eligible entry: priority then arrival; only 'verify' while paused. */
  private next(): Entry | undefined {
    let best: Entry | undefined
    for (const e of this.items) {
      if (this.paused && e.cmd.priority !== 'verify') continue
      if (
        !best ||
        RANK[e.cmd.priority] < RANK[best.cmd.priority] ||
        (RANK[e.cmd.priority] === RANK[best.cmd.priority] && e.seq < best.seq)
      ) {
        best = e
      }
    }
    return best
  }

  private pump(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    if (this.inFlight) return
    const entry = this.next()
    if (!entry) return

    const now = Date.now()
    const readyAt = Math.max(this.lastSendAt + this.opts.minGapMs(), this.holdUntil)
    if (now < readyAt) {
      this.pumpTimer = setTimeout(() => this.pump(), readyAt - now)
      return
    }

    this.items.splice(this.items.indexOf(entry), 1)
    this.dispatch(entry.cmd)
  }

  /**
   * The bot acknowledged the in-flight command and will answer later (deferred reply):
   * wait up to `ms` from now instead of the normal response timeout.
   */
  extendTimeout(ms: number): void {
    if (this.inFlight) this.armTimeout(this.inFlight.cmd, this.inFlight.id, ms)
  }

  private armTimeout(cmd: QueuedCommand, id: number, ms: number): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = setTimeout(() => {
      if (this.inFlight?.id !== id) return
      this.release()
      this.timeoutCb(cmd)
      this.pump()
    }, ms)
  }

  private dispatch(cmd: QueuedCommand): void {
    const id = ++this.flightId
    this.inFlight = { cmd, id }
    this.lastSendAt = Date.now()
    this.armTimeout(cmd, id, this.opts.responseTimeoutMs)

    const fail = (err: unknown): void => {
      if (this.inFlight?.id !== id) return
      this.release()
      this.sendErrorCb(cmd, err)
      this.pump()
    }
    try {
      this.send(cmd).catch(fail)
    } catch (err) {
      fail(err)
    }
  }
}
