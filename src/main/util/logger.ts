import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { maskSecrets } from './maskSecrets'

const MAX_BYTES = 5 * 1024 * 1024

export type Logger = {
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
}

function stringify(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`
  try {
    return ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
  } catch {
    return ` ${String(extra)}`
  }
}

export function createLogger(dir: string): Logger {
  const file = join(dir, 'app.log')
  const rotated = join(dir, 'app.1.log')

  const write = (level: string, msg: string, extra?: unknown): void => {
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        rmSync(rotated, { force: true })
        renameSync(file, rotated)
      }
      const line = maskSecrets(`${new Date().toISOString()} ${level} ${msg}${stringify(extra)}`)
      appendFileSync(file, line + '\n', 'utf8')
    } catch {
      // logging must never crash the app
    }
  }

  return {
    info: (m, e) => write('INFO', m, e),
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e)
  }
}
