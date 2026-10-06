import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommandQueue, type QueuedCommand } from '../../src/main/engine/CommandQueue'

let gap = 2500
const mk = () => {
  const sent: string[] = []
  const send = vi.fn(async (c: QueuedCommand) => {
    sent.push(c.name)
  })
  const q = new CommandQueue(send, { minGapMs: () => gap, responseTimeoutMs: 8000 })
  return { q, send, sent }
}

beforeEach(() => {
  vi.useFakeTimers()
  gap = 2500
})
afterEach(() => vi.useRealTimers())

describe('CommandQueue', () => {
  it('sends manual before an earlier-pushed fish', async () => {
    const { q, sent } = mk()
    q.pause()
    q.push({ name: 'fish', priority: 'fish' })
    q.push({ name: 'manual', priority: 'manual' })
    q.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['manual'])
  })

  it('orders by priority then arrival', async () => {
    const { q, sent } = mk()
    q.holdFor(1000)
    q.push({ name: 'f1', priority: 'fish' })
    q.push({ name: 'm1', priority: 'maintenance' })
    q.push({ name: 'f2', priority: 'fish' })
    q.push({ name: 'v1', priority: 'verify' })
    q.push({ name: 'u1', priority: 'manual' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toEqual(['u1'])
    q.notifyResponse()
    sent.length = 0
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0)
      q.notifyResponse()
      await vi.advanceTimersByTimeAsync(2500)
    }
    expect(sent).toEqual(['v1', 'm1', 'f1', 'f2'])
  })

  it('waits for notifyResponse and for minGap between sends', async () => {
    const { q, sent } = mk()
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a'])
    // no response yet: nothing more even after the gap
    await vi.advanceTimersByTimeAsync(3000)
    expect(sent).toEqual(['a'])
    // response arrives after the gap elapsed: sends immediately
    q.notifyResponse()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a', 'b'])
  })

  it('respects minGap when the response is faster', async () => {
    const { q, sent } = mk()
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    q.notifyResponse()
    await vi.advanceTimersByTimeAsync(1900)
    expect(sent).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual(['a', 'b'])
  })

  it('reads minGapMs at each scheduling decision', async () => {
    const { q, sent } = mk()
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    gap = 5000
    q.notifyResponse()
    await vi.advanceTimersByTimeAsync(4900)
    expect(sent).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual(['a', 'b'])
  })

  it('calls onTimeout after 8000 ms and continues', async () => {
    const { q, sent } = mk()
    const onTimeout = vi.fn()
    q.onTimeout(onTimeout)
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(7999)
    expect(onTimeout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0][0].name).toBe('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a', 'b'])
  })

  it('does not fire a timeout after a response', async () => {
    const { q } = mk()
    const onTimeout = vi.fn()
    q.onTimeout(onTimeout)
    q.push({ name: 'a', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    q.notifyResponse()
    await vi.advanceTimersByTimeAsync(20000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('notifyResponse with nothing in flight is a no-op', async () => {
    const { q, sent } = mk()
    q.notifyResponse()
    q.push({ name: 'a', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a'])
    q.notifyResponse()
    q.notifyResponse() // second one must not release anything
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(sent).toEqual(['a', 'b'])
  })

  it('rejects a duplicate key already queued', () => {
    const { q } = mk()
    q.pause()
    expect(q.push({ name: 'sell', priority: 'maintenance', key: 'sell' })).toBe(true)
    expect(q.push({ name: 'sell', priority: 'maintenance', key: 'sell' })).toBe(false)
    expect(q.size).toBe(1)
  })

  it('pause stops sending, resume restarts', async () => {
    const { q, sent } = mk()
    q.pause()
    q.push({ name: 'a', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(sent).toEqual([])
    q.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['a'])
  })

  it('R6a: verify still goes out while paused, fish does not', async () => {
    const { q, sent } = mk()
    q.pause()
    q.push({ name: 'fish', priority: 'fish' })
    q.push({ name: 'verify', priority: 'verify' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(sent).toEqual(['verify'])
  })

  it('R6b: holdFor blocks sending until elapsed', async () => {
    const { q, sent } = mk()
    q.holdFor(5000)
    q.push({ name: 'a', priority: 'manual' })
    await vi.advanceTimersByTimeAsync(4999)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['a'])
  })

  it('send rejection does not jam the queue', async () => {
    const sent: string[] = []
    const send = vi.fn(async (c: QueuedCommand) => {
      sent.push(c.name)
      if (c.name === 'a') throw new Error('net')
    })
    const q = new CommandQueue(send, { minGapMs: () => gap, responseTimeoutMs: 8000 })
    const onSendError = vi.fn()
    const onTimeout = vi.fn()
    q.onSendError(onSendError)
    q.onTimeout(onTimeout)
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    await vi.advanceTimersByTimeAsync(0)
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError.mock.calls[0][0].name).toBe('a')
    expect(sent).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(2500)
    expect(sent).toEqual(['a', 'b'])
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('clear empties the queue', async () => {
    const { q, sent } = mk()
    q.pause()
    q.push({ name: 'a', priority: 'fish' })
    q.push({ name: 'b', priority: 'fish' })
    q.clear()
    expect(q.size).toBe(0)
    q.resume()
    await vi.advanceTimersByTimeAsync(10000)
    expect(sent).toEqual([])
  })
})
