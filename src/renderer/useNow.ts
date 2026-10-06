import { useSyncExternalStore } from 'react'

const TICK_MS = 250
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let now = Date.now()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Current time in ms, refreshed every 250 ms by ONE shared interval. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now)
}
