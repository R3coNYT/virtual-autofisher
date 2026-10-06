import { describe, expect, it, vi } from 'vitest'
import { detectVirtualFisher } from '../../src/main/discord/detectVirtualFisher'
import { VIRTUAL_FISHER_ID } from '../../src/main/discord/DiscordClient'

const idx = (applications: { id: string; bot_id?: string }[]) => async () => ({ applications })

describe('detectVirtualFisher', () => {
  it('cached value wins, no request', async () => {
    const cache = new Map([['g', false]])
    const fetchIndex = vi.fn()
    expect(await detectVirtualFisher('g', { cache, inMemberCache: () => true, fetchIndex })).toBe(false)
    expect(fetchIndex).not.toHaveBeenCalled()
  })
  it('member cache hit: true, cached, no request', async () => {
    const cache = new Map<string, boolean>()
    const fetchIndex = vi.fn()
    expect(await detectVirtualFisher('g', { cache, inMemberCache: () => true, fetchIndex })).toBe(true)
    expect(cache.get('g')).toBe(true)
    expect(fetchIndex).not.toHaveBeenCalled()
  })
  it('index lists VF by id or bot_id: true, cached', async () => {
    for (const app of [{ id: VIRTUAL_FISHER_ID }, { id: 'x', bot_id: VIRTUAL_FISHER_ID }]) {
      const cache = new Map<string, boolean>()
      expect(await detectVirtualFisher('g', { cache, inMemberCache: () => false, fetchIndex: idx([app]) })).toBe(true)
      expect(cache.get('g')).toBe(true)
    }
  })
  it('index lacks VF: false, cached as false', async () => {
    const cache = new Map<string, boolean>()
    expect(await detectVirtualFisher('g', { cache, inMemberCache: () => false, fetchIndex: idx([{ id: 'other' }]) })).toBe(false)
    expect(cache.get('g')).toBe(false)
  })
  it('error: false, not cached', async () => {
    const cache = new Map<string, boolean>()
    const fetchIndex = async () => {
      throw new Error('429')
    }
    expect(await detectVirtualFisher('g', { cache, inMemberCache: () => false, fetchIndex })).toBe(false)
    expect(cache.has('g')).toBe(false)
  })
})
