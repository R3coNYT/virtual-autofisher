import type { Config, DeepPartial, SlashCommandInfo } from '../shared/types'

type Patch = DeepPartial<Config>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const atLeast = (v: number, min: number): number => Math.max(min, v)
const between = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** Applies `fn` to a numeric value; a non-numeric value yields undefined (the key is then dropped). */
function clampKey(v: unknown, fn: (n: number) => number): number | undefined {
  const n = num(v)
  return n === null ? undefined : fn(n)
}

function cleanSection(o: Record<string, unknown>): void {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
}

/** Single source of the numeric ranges, used by the inputs and by clampConfigPatch. */
export const BOUNDS = {
  baseCooldownSec: { min: 2 },
  minGapSec: { min: 2 },
  jitterSec: { min: 0, max: 5 },
  sellEvery: { min: 1 },
  refreshMin: { min: 1 },
  breakMin: { min: 0 },
  baitAmount: { min: 0 },
  sessionLimitH: { min: 0 }
} as const

/**
 * Brings a settings patch back into the supported ranges before it is sent to main.
 * Pure: untouched keys pass through, non-numeric values for bounded fields are dropped.
 */
export function clampConfigPatch(patch: Patch): Patch {
  const out: Patch = structuredClone(patch)

  if (out.fishing) {
    const f = out.fishing
    if ('baseCooldownSec' in f) f.baseCooldownSec = clampKey(f.baseCooldownSec, (v) => atLeast(v, BOUNDS.baseCooldownSec.min))
    if ('minGapSec' in f) f.minGapSec = clampKey(f.minGapSec, (v) => atLeast(v, BOUNDS.minGapSec.min))
    if ('jitterSec' in f) f.jitterSec = clampKey(f.jitterSec, (v) => between(v, BOUNDS.jitterSec.min, BOUNDS.jitterSec.max))
  }
  if (out.buffs && 'lengthMin' in out.buffs) {
    const v = num(out.buffs.lengthMin)
    // only 5 and 20 exist: anything closer to 20 than to 5 becomes 20
    out.buffs.lengthMin = v === null ? undefined : v >= 12.5 ? 20 : 5
  }
  if (out.sell && 'every' in out.sell) out.sell.every = clampKey(out.sell.every, (v) => atLeast(Math.round(v), BOUNDS.sellEvery.min))
  if (out.profile && 'refreshMin' in out.profile) out.profile.refreshMin = clampKey(out.profile.refreshMin, (v) => atLeast(v, BOUNDS.refreshMin.min))
  if (out.breaks) {
    const b = out.breaks
    for (const k of ['workMin', 'workJitterMin', 'restMin', 'restJitterMin'] as const) {
      if (k in b) b[k] = clampKey(b[k], (v) => atLeast(v, BOUNDS.breakMin.min))
    }
  }
  if (out.bait && 'amount' in out.bait) out.bait.amount = clampKey(out.bait.amount, (v) => atLeast(Math.round(v), BOUNDS.baitAmount.min))
  if ('sessionLimitH' in out) out.sessionLimitH = clampKey(out.sessionLimitH, (v) => atLeast(v, BOUNDS.sessionLimitH.min))

  for (const key of ['fishing', 'buffs', 'sell', 'profile', 'breaks', 'bait'] as const) {
    const section = out[key]
    if (!section) continue
    cleanSection(section as Record<string, unknown>)
    if (Object.keys(section).length === 0) delete out[key]
  }
  if ('sessionLimitH' in out && out.sessionLimitH === undefined) delete out.sessionLimitH
  return out
}

/** Parses a text field ("3,5" or "3.5") to a number, null when it is not one. */
export function parseNumberInput(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'))
  return raw.trim() !== '' && Number.isFinite(n) ? n : null
}

/** True when the command list is known and lacks `name` (an empty list means "not discovered yet"). */
export function commandMissing(commands: { name: string }[], name: string): boolean {
  return commands.length > 0 && !commands.some((c) => c.name === name)
}

/**
 * "New image" is offered when /verify exists and either exposes a 'regen' choice or takes a
 * free string first option (the bot accepts the answer 'regen' there).
 */
export function canRegen(commands: Pick<SlashCommandInfo, 'name' | 'options'>[]): boolean {
  const first = commands.find((c) => c.name === 'verify')?.options[0]
  if (!first) return false
  if (first.choices && first.choices.length > 0) return first.choices.includes('regen')
  return first.type === 3
}
