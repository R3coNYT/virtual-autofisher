import type { Config } from '../../shared/types'

/** Standard normal draw (Box-Muller) from an injectable uniform source. */
function gaussian(rand: () => number): number {
  const u1 = 1 - rand() // (0, 1]: avoids log(0)
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Delay before the next /fish, in ms: truncated normal centered on `base`,
 * std-dev `jitter / 2`, clamped to [max(2, base - jitter), base + jitter] seconds.
 */
export function fishDelayMs(cfg: Config['fishing'], rand: () => number = Math.random): number {
  const { baseCooldownSec: base, jitterSec: jitter } = cfg
  const lo = Math.max(2, base - jitter)
  const hi = Math.max(lo, base + jitter)
  const v = base + gaussian(rand) * (jitter / 2)
  return Math.min(hi, Math.max(lo, v)) * 1000
}

/** Uniform random delay in ms between `minS` and `maxS` seconds. */
export function randomBetweenMs(minS: number, maxS: number, rand: () => number = Math.random): number {
  return (minS + rand() * (maxS - minS)) * 1000
}
