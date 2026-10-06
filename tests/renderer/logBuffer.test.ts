import { describe, expect, it } from 'vitest'
import { MAX_LOG, appendCapped } from '../../src/renderer/logBuffer'

describe('appendCapped', () => {
  it('keeps only the newest 500 entries', () => {
    const mk = (id: number) => ({ id, at: id, type: 'system' as const, text: String(id) })
    const first = appendCapped([], Array.from({ length: 480 }, (_, i) => mk(i)))
    const log = appendCapped(first, Array.from({ length: 60 }, (_, i) => mk(480 + i)))
    expect(MAX_LOG).toBe(500)
    expect(log).toHaveLength(500)
    expect(log[0].id).toBe(40)
    expect(log.at(-1)?.id).toBe(539)
  })
})
