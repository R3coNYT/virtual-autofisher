import type { LogEntry } from '../shared/types'

export const MAX_LOG = 500

/** Appends entries and keeps only the newest MAX_LOG. */
export function appendCapped(log: LogEntry[], entries: LogEntry[]): LogEntry[] {
  const merged = log.concat(entries)
  return merged.length > MAX_LOG ? merged.slice(merged.length - MAX_LOG) : merged
}
