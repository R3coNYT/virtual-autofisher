import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type Config, type DeepPartial } from '../../shared/types'
import { createLogger, type Logger } from '../util/logger'

export interface Cipher {
  encrypt(s: string): string
  decrypt(b64: string): string
  available(): boolean
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fusion profonde ; les objets nullables (target) sont remplacés en bloc. */
function merge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k] as Obj, v) : v
  }
  return out
}

export class ConfigStore {
  private config: Config = structuredClone(DEFAULT_CONFIG)
  private listeners = new Set<(c: Config) => void>()
  private readonly file: string
  private readonly backup: string

  constructor(
    private readonly dir: string,
    private readonly cipher: Cipher,
    private readonly log: Logger = createLogger(join(dir, 'logs'))
  ) {
    this.file = join(dir, 'config.json')
    this.backup = join(dir, 'config.bak.json')
  }

  load(): Config {
    this.config = structuredClone(DEFAULT_CONFIG)
    if (!existsSync(this.file)) return this.get()
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!isObj(parsed)) throw new Error('config invalide')
      const { target, ...rest } = parsed
      const merged = merge(DEFAULT_CONFIG as unknown as Obj, rest)
      if (target === null || isObj(target)) merged.target = target
      this.config = merged as unknown as Config
    } catch (e) {
      this.log.warn('Configuration corrompue, retour aux valeurs par défaut', e)
      try {
        renameSync(this.file, this.backup)
      } catch (err) {
        this.log.error('Sauvegarde de la configuration corrompue impossible', err)
      }
      this.config = structuredClone(DEFAULT_CONFIG)
    }
    return this.get()
  }

  get(): Config {
    return structuredClone(this.config)
  }

  update(patch: DeepPartial<Config>): Config {
    const { target, ...rest } = patch as Obj
    const merged = merge(this.config as unknown as Obj, rest)
    if (target !== undefined) merged.target = target
    this.config = merged as unknown as Config
    return this.commit()
  }

  setToken(token: string): void {
    if (!this.cipher.available()) throw new Error('Chiffrement indisponible')
    this.config.tokenEncrypted = this.cipher.encrypt(token)
    this.commit()
  }

  getToken(): string | null {
    const enc = this.config.tokenEncrypted
    if (!enc) return null
    try {
      return this.cipher.decrypt(enc)
    } catch (e) {
      this.log.warn('Déchiffrement du token impossible', e)
      return null
    }
  }

  clearToken(): void {
    delete this.config.tokenEncrypted
    this.commit()
  }

  onChange(cb: (c: Config) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private commit(): Config {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf8')
    const snap = this.get()
    for (const cb of this.listeners) cb(snap)
    return snap
  }
}
