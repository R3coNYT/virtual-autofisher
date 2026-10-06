import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/types'

describe('DEFAULT_CONFIG', () => {
  it('a les valeurs de pêche par défaut', () => {
    expect(DEFAULT_CONFIG.fishing).toEqual({ baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 })
  })
  it('a les valeurs de vente par défaut', () => {
    expect(DEFAULT_CONFIG.sell).toEqual({ enabled: true, mode: 'catches', every: 25 })
  })
})
