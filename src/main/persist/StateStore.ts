import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedAccount } from '../../shared/types'
import type { Logger } from '../util/logger'

/** Contents of <userData>/state.json. Never holds the token or anything from the config. */
export type PersistedState = {
  version: 1
  /** Values with a wrong type in the file are dropped, so every field may be missing. */
  account: Partial<PersistedAccount>
  /** Epoch ms when the next /daily is available, null when unknown. */
  nextDailyAt: number | null
  /** Virtual Fisher detection per guild id (not secret). Missing in old files: {}. */
  vfGuilds: Record<string, boolean>
  savedAt: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): boolean => v === null || isNum(v)
const strOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const numbers = (v: unknown): boolean => isObj(v) && Object.values(v).every(isNum)

/** Type check of each persisted account field (a value failing it is dropped). */
const CHECKS: { [K in keyof PersistedAccount]: (v: unknown) => boolean } = {
  balance: numOrNull,
  fishValue: numOrNull,
  level: numOrNull,
  xpToNext: numOrNull,
  rod: strOrNull,
  biome: strOrNull,
  bait: (v) => v === null || (isObj(v) && typeof v.name === 'string' && isNum(v.count)),
  rare: (v) => numbers(v) && ['gold', 'emerald', 'lava', 'diamond'].every((k) => isNum((v as Obj)[k])),
  totals: numbers,
  personalBoosters: numOrNull
}

/**
 * Account values and the next daily, kept between sessions and app restarts. No electron
 * import: the directory is injected. Writes are atomic (tmp + rename); a corrupt file is set
 * aside as state.bak.json and ignored.
 */
export class StateStore {
  private readonly file: string
  private readonly backup: string
  private vf: Record<string, boolean> = {}
  private vfLoaded = false

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now
  ) {
    this.file = join(dir, 'state.json')
    this.backup = join(dir, 'state.bak.json')
  }

  load(): PersistedState | null {
    if (!existsSync(this.file)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (e) {
      this.log.warn('Corrupt state.json, ignored', e)
      try {
        renameSync(this.file, this.backup)
      } catch (err) {
        this.log.error('Unable to back up the corrupt state.json', err)
      }
      return null
    }
    if (!isObj(parsed) || parsed.version !== 1 || !isObj(parsed.account)) {
      this.log.warn('Unsupported state.json, ignored')
      return null
    }
    const account: Obj = {}
    for (const [k, check] of Object.entries(CHECKS)) {
      const v = parsed.account[k]
      if (v !== undefined && check(v)) account[k] = v
    }
    const vfGuilds: Record<string, boolean> = {}
    if (isObj(parsed.vfGuilds)) for (const [k, v] of Object.entries(parsed.vfGuilds)) if (typeof v === 'boolean') vfGuilds[k] = v
    this.vf = vfGuilds
    this.vfLoaded = true
    return {
      version: 1,
      account: account as Partial<PersistedAccount>,
      nextDailyAt: isNum(parsed.nextDailyAt) ? parsed.nextDailyAt : null,
      vfGuilds,
      savedAt: isNum(parsed.savedAt) ? parsed.savedAt : 0
    }
  }

  save(s: { account: Partial<PersistedAccount>; nextDailyAt: number | null }): void {
    if (!this.vfLoaded) this.load() // keep the persisted detection map when a game save comes first
    this.write(s.account, s.nextDailyAt)
  }

  getVfGuilds(): Record<string, boolean> {
    if (!this.vfLoaded) this.load()
    return { ...this.vf }
  }

  /** Replaces the persisted Virtual Fisher detection map, keeping account and next daily as stored. */
  setVfGuilds(map: Record<string, boolean>): void {
    const cur = this.load() // also (re)reads the file; resets this.vf, overwritten below
    this.vf = { ...map }
    this.vfLoaded = true
    this.write(cur?.account ?? {}, cur?.nextDailyAt ?? null)
  }

  private write(account: Partial<PersistedAccount>, nextDailyAt: number | null): void {
    const out: PersistedState = { version: 1, account, nextDailyAt, vfGuilds: this.vf, savedAt: this.now() }
    mkdirSync(this.dir, { recursive: true })
    // atomic: a crash mid-write leaves at worst a stray state.json.tmp, never a truncated state.json
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
