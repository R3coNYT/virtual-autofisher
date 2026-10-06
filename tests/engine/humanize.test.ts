import { describe, it, expect } from 'vitest'
import { fishDelayMs, randomBetweenMs } from '../../src/main/engine/humanize'

describe('fishDelayMs', () => {
  it('stays within [base-jitter, base+jitter] over 1000 draws', () => {
    const cfg = { baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 }
    for (let i = 0; i < 1000; i++) {
      const d = fishDelayMs(cfg)
      expect(d).toBeGreaterThanOrEqual(2700)
      expect(d).toBeLessThanOrEqual(4300)
    }
  })
  it('never goes under 2000 ms even with base=2, jitter=1', () => {
    const cfg = { baseCooldownSec: 2, jitterSec: 1, minGapSec: 2.5 }
    for (let i = 0; i < 1000; i++) {
      const d = fishDelayMs(cfg)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThanOrEqual(3000)
    }
  })
  it('is clamped with extreme random values', () => {
    const cfg = { baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 }
    expect(fishDelayMs(cfg, () => 0)).toBeGreaterThanOrEqual(2700)
    expect(fishDelayMs(cfg, () => 0.999999999)).toBeLessThanOrEqual(4300)
  })
  it('is centered on base with a deterministic rand', () => {
    const cfg = { baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 }
    // rand=0.5 -> cos(2*pi*0.5) = -1 ... use a rand giving cos=0: u1=0.5 then u2=0.25
    const seq = [0.5, 0.25]
    let i = 0
    expect(Math.round(fishDelayMs(cfg, () => seq[i++ % 2]))).toBe(3500)
  })
})

describe('randomBetweenMs', () => {
  it('maps rand to the [min,max] seconds range in ms', () => {
    expect(randomBetweenMs(5, 15, () => 0)).toBe(5000)
    expect(randomBetweenMs(5, 15, () => 0.5)).toBe(10000)
    for (let i = 0; i < 200; i++) {
      const v = randomBetweenMs(5, 15)
      expect(v).toBeGreaterThanOrEqual(5000)
      expect(v).toBeLessThanOrEqual(15000)
    }
  })
})
