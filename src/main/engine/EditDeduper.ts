import type { GameEvent } from '../../shared/types'

type Kind = GameEvent['kind']
type Seen = { kind: Kind; text: string }

const MAX_IDS = 200
/** Kinds that change counters: an edit must never count them a second time. */
const COUNTED: Kind[] = ['catch', 'sell', 'purchase', 'daily']
const CAPTCHA_KINDS: Kind[] = ['captcha', 'captchaSolved', 'captchaFailed']

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Remembers, per message id, what was last parsed from it, so that Discord edits
 * (embeds resolving, buttons removed, …) are not counted twice. Bounded to the last 200 ids.
 */
export class EditDeduper {
  private seen = new Map<string, Seen>()
  /** Ids that carried a captcha since it was last solved. */
  private captchaIds = new Set<string>()
  /** Ids whose captcha was solved: an edit of them never re-enters the captcha. */
  private solvedIds = new Set<string>()

  /** Returns true when the event must be routed, false when the message must be ignored. */
  accept(id: string, isEdit: boolean, ev: GameEvent, text: string): boolean {
    const norm = normalize(text)
    const prev = this.seen.get(id)
    let accepted = true
    if (isEdit) {
      if (prev && prev.kind === ev.kind && prev.text === norm) accepted = false // unchanged
      else if (ev.kind === 'captcha' && this.solvedIds.has(id)) accepted = false // already solved
      else if (prev && !CAPTCHA_KINDS.includes(ev.kind) && COUNTED.includes(prev.kind)) accepted = false
      // an edit of a message we never saw (sent before the session, or forgotten): typically another
      // player clicking a button of an old reply of ours. Only a captcha or a cooldown may matter then.
      else if (!prev && !CAPTCHA_KINDS.includes(ev.kind) && ev.kind !== 'cooldown') accepted = false
    }
    // a counted kind stays the reference: later edits of that message are never counted either
    const kind = !accepted && prev && COUNTED.includes(prev.kind) ? prev.kind : ev.kind
    this.remember(id, { kind, text: norm })
    if (accepted && ev.kind === 'captcha') this.captchaIds.add(id)
    if (accepted && ev.kind === 'captchaSolved') {
      for (const c of this.captchaIds) this.solvedIds.add(c)
      this.solvedIds.add(id)
      this.captchaIds.clear()
      trim(this.solvedIds)
    }
    return accepted
  }

  private remember(id: string, s: Seen): void {
    this.seen.delete(id) // re-insert: most recent last
    this.seen.set(id, s)
    while (this.seen.size > MAX_IDS) this.seen.delete(this.seen.keys().next().value as string)
  }
}

function trim(set: Set<string>): void {
  while (set.size > MAX_IDS) set.delete(set.values().next().value as string)
}
