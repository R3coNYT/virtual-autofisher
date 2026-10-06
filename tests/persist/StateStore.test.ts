import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore } from '../../src/main/persist/StateStore'
import type { PersistedAccount } from '../../src/shared/types'

const account: PersistedAccount = {
  balance: 136_570_161,
  fishValue: 32_180_326,
  level: 154,
  xpToNext: 75_640,
  rod: 'Superium Rod',
  biome: 'Ocean',
  bait: { name: 'Magic Bait', count: 34_414 },
  rare: { gold: 2353, emerald: 887, lava: 43, diamond: 77 },
  totals: { gold: 10, crates: 3 },
  personalBoosters: 1
}

let dir: string
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-state-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('StateStore', () => {
  it('no file → null', () => {
    expect(new StateStore(dir, logger()).load()).toBeNull()
  })

  it('round trip: version 1, account, nextDailyAt, savedAt', () => {
    const store = new StateStore(dir, logger(), () => 1234)
    store.save({ account, nextDailyAt: 99 })
    const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    expect(raw).toEqual({ version: 1, account, nextDailyAt: 99, vfGuilds: {}, savedAt: 1234 })
    expect(new StateStore(dir, logger()).load()).toEqual({ version: 1, account, nextDailyAt: 99, vfGuilds: {}, savedAt: 1234 })
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false)
  })

  it('corrupt file → ignored (null), kept aside as state.bak.json, warned', () => {
    writeFileSync(join(dir, 'state.json'), '{not json')
    const log = logger()
    expect(new StateStore(dir, log).load()).toBeNull()
    expect(existsSync(join(dir, 'state.bak.json'))).toBe(true)
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
    expect(log.warn).toHaveBeenCalled()
  })

  it('unknown version or shape → ignored', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 2, account }))
    expect(new StateStore(dir, logger()).load()).toBeNull()
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, account: 'x' }))
    expect(new StateStore(dir, logger()).load()).toBeNull()
  })

  it('wrongly typed values are dropped, the rest is kept', () => {
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, account: { ...account, balance: 'lots', rare: null }, nextDailyAt: 'soon', savedAt: 5 })
    )
    const s = new StateStore(dir, logger()).load()!
    expect(s.account.balance).toBeUndefined()
    expect(s.account.rare).toBeUndefined()
    expect(s.account.level).toBe(154)
    expect(s.nextDailyAt).toBeNull()
  })

  it('a stray state.json.tmp (crash mid-write) does not matter', () => {
    writeFileSync(join(dir, 'state.json.tmp'), '{half')
    const store = new StateStore(dir, logger())
    expect(store.load()).toBeNull()
    store.save({ account, nextDailyAt: null })
    expect(store.load()?.account).toEqual(account)
  })

  it('vfGuilds: old files without it load as {}', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, account, nextDailyAt: null, savedAt: 1 }))
    expect(new StateStore(dir, logger()).load()?.vfGuilds).toEqual({})
  })

  it('vfGuilds: wrongly typed entries are dropped', () => {
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, account, nextDailyAt: null, vfGuilds: { a: true, b: false, c: 'yes' }, savedAt: 1 })
    )
    expect(new StateStore(dir, logger()).load()?.vfGuilds).toEqual({ a: true, b: false })
  })

  it('setVfGuilds persists, keeps account, and later save() keeps the map', () => {
    const store = new StateStore(dir, logger())
    store.save({ account, nextDailyAt: 5 })
    store.setVfGuilds({ g1: true, g2: false })
    const again = new StateStore(dir, logger())
    expect(again.load()).toMatchObject({ account, nextDailyAt: 5, vfGuilds: { g1: true, g2: false } })
    again.save({ account: { ...account, level: 1 }, nextDailyAt: 6 }) // game save must not wipe the map
    expect(new StateStore(dir, logger()).load()?.vfGuilds).toEqual({ g1: true, g2: false })
    expect(new StateStore(dir, logger()).getVfGuilds()).toEqual({ g1: true, g2: false })
  })

  it('setVfGuilds without any file creates one with empty account', () => {
    const store = new StateStore(dir, logger())
    store.setVfGuilds({ g: true })
    expect(new StateStore(dir, logger()).load()).toMatchObject({ account: {}, vfGuilds: { g: true } })
  })

  it('creates the directory when missing', () => {
    const sub = join(dir, 'nested', 'userData')
    new StateStore(sub, logger()).save({ account, nextDailyAt: 1 })
    expect(existsSync(join(sub, 'state.json'))).toBe(true)
  })
})
