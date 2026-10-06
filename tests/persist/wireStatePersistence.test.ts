import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameState } from '../../src/main/engine/GameState'
import { StateStore } from '../../src/main/persist/StateStore'
import { wireStatePersistence } from '../../src/main/persist/wireStatePersistence'

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const noEngine = { onSessionEnd: () => () => {} }
const inventory = {
  kind: 'inventory' as const,
  balance: 157_175_405,
  level: 160,
  xpToNext: 1000,
  rare: { gold: 1, emerald: 2, lava: 3, diamond: 4 },
  fishValue: 213_669_643
}

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'vaf-persist-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('wireStatePersistence', () => {
  it('saves account values shortly after a manual /profile, without a session end or a clean quit', () => {
    const state = new GameState()
    wireStatePersistence({ state, engine: noEngine, store: new StateStore(dir, logger()), logger: logger() })
    state.apply(inventory) // e.g. a manual /profile while idle
    vi.advanceTimersByTime(3000)

    // the app is killed here (no before-quit): a fresh start must see the values
    const reopened = new GameState()
    wireStatePersistence({ state: reopened, engine: noEngine, store: new StateStore(dir, logger()), logger: logger() })
    expect(reopened.snapshot().account).toMatchObject({ balance: 157_175_405, fishValue: 213_669_643, level: 160 })
  })

  it('debounces bursts of account changes into one write', () => {
    const state = new GameState()
    const store = new StateStore(dir, logger())
    const save = vi.spyOn(store, 'save')
    wireStatePersistence({ state, engine: noEngine, store, logger: logger() })
    state.apply(inventory)
    state.apply({ ...inventory, balance: 1 })
    state.apply({ ...inventory, balance: 2 })
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3000)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
