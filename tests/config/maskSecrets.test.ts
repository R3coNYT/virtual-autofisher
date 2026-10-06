import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskSecrets } from '../../src/main/util/maskSecrets'
import { createLogger } from '../../src/main/util/logger'

const TOKEN = 'MTA4MTIzNDU2Nzg5MDEyMzQ1Ng.GabcdE.abcdefghijklmnopqrstuvwxyz0'

describe('maskSecrets', () => {
  it('masque un token Discord', () => {
    const out = maskSecrets(`token ${TOKEN} here`)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('***TOKEN***')
  })
  it('laisse le texte sans secret intact', () => {
    expect(maskSecrets('rien a voir')).toBe('rien a voir')
  })
})

describe('logger', () => {
  it('masque les secrets dans les lignes écrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'))
    const log = createLogger(dir)
    log.info(`login ${TOKEN}`, { t: TOKEN })
    const content = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(content).not.toContain(TOKEN)
    expect(content).toContain('***TOKEN***')
    expect(content).toContain('INFO')
  })
  it('fait une rotation au-delà de 5 Mo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'))
    writeFileSync(join(dir, 'app.log'), 'x'.repeat(5 * 1024 * 1024 + 1))
    const log = createLogger(dir)
    log.warn('après rotation')
    expect(existsSync(join(dir, 'app.1.log'))).toBe(true)
    expect(statSync(join(dir, 'app.1.log')).size).toBeGreaterThan(5 * 1024 * 1024)
    const content = readFileSync(join(dir, 'app.log'), 'utf8')
    expect(content).toContain('après rotation')
    expect(content.length).toBeLessThan(1000)
  })
})
