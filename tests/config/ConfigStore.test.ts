import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, type Cipher } from '../../src/main/config/ConfigStore'
import { DEFAULT_CONFIG } from '../../src/shared/types'

const rev = (s: string) => s.split('').reverse().join('')
const fakeCipher = (avail = true): Cipher => ({
  encrypt: (s) => Buffer.from(rev(s)).toString('base64'),
  decrypt: (b) => rev(Buffer.from(b, 'base64').toString()),
  available: () => avail
})
const tmp = () => mkdtempSync(join(tmpdir(), 'cfg-'))

describe('ConfigStore', () => {
  it('load sans fichier retourne DEFAULT_CONFIG', () => {
    expect(new ConfigStore(tmp(), fakeCipher()).load()).toEqual(DEFAULT_CONFIG)
  })
  it('update fusionne en profondeur et persiste', () => {
    const dir = tmp()
    const s = new ConfigStore(dir, fakeCipher())
    s.load()
    const c = s.update({ sell: { every: 10 } })
    expect(c.sell).toEqual({ ...DEFAULT_CONFIG.sell, every: 10 })
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(onDisk.sell.every).toBe(10)
    expect(onDisk.sell.enabled).toBe(true)
    expect(new ConfigStore(dir, fakeCipher()).load().sell.every).toBe(10)
  })
  it('update remplace target en bloc', () => {
    const s = new ConfigStore(tmp(), fakeCipher())
    s.load()
    expect(s.update({ target: { guildId: 'g', channelId: 'c' } }).target).toEqual({ guildId: 'g', channelId: 'c' })
    expect(s.update({ target: null }).target).toBeNull()
  })
  it('setToken chiffre : rien en clair sur disque', () => {
    const dir = tmp()
    const s = new ConfigStore(dir, fakeCipher())
    s.load()
    s.setToken('abc')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('abc')
    expect(s.getToken()).toBe('abc')
    const reopened = new ConfigStore(dir, fakeCipher())
    reopened.load()
    expect(reopened.getToken()).toBe('abc')
    s.clearToken()
    expect(s.getToken()).toBeNull()
  })
  it('setToken lève si chiffrement indisponible', () => {
    const s = new ConfigStore(tmp(), fakeCipher(false))
    s.load()
    expect(() => s.setToken('abc')).toThrow('Chiffrement indisponible')
  })
  it('getToken retourne null si le déchiffrement échoue', () => {
    const dir = tmp()
    const s = new ConfigStore(dir, fakeCipher())
    s.load()
    s.setToken('abc')
    const bad: Cipher = { ...fakeCipher(), decrypt: () => { throw new Error('boom') } }
    const s2 = new ConfigStore(dir, bad)
    s2.load()
    expect(s2.getToken()).toBeNull()
  })
  it('JSON corrompu : défauts et sauvegarde config.bak.json', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), '{not json')
    expect(new ConfigStore(dir, fakeCipher()).load()).toEqual(DEFAULT_CONFIG)
    expect(readFileSync(join(dir, 'config.bak.json'), 'utf8')).toBe('{not json')
    expect(existsSync(join(dir, 'config.bak.json'))).toBe(true)
  })
  it('onChange notifie et se désabonne', () => {
    const s = new ConfigStore(tmp(), fakeCipher())
    s.load()
    const seen: number[] = []
    const off = s.onChange((c) => seen.push(c.sell.every))
    s.update({ sell: { every: 7 } })
    off()
    s.update({ sell: { every: 8 } })
    expect(seen).toEqual([7])
  })
})
