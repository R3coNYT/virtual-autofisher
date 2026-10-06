import { useRef } from 'react'
import { useNow } from '../useNow'

const R = 26
const C = 2 * Math.PI * R

/** Ring that drains from the snapshot's nextFishAt. */
export function CooldownRing({ nextFishAt, fallbackMs }: { nextFishAt: number | null; fallbackMs: number }): JSX.Element {
  const now = useNow()
  const total = useRef({ target: null as number | null, ms: fallbackMs })
  if (nextFishAt !== total.current.target) {
    // new cooldown: remember its full length (as first observed) to scale the ring
    const first = nextFishAt == null ? fallbackMs : nextFishAt - Date.now()
    total.current = { target: nextFishAt, ms: Math.max(first, 1000) }
  }
  const remaining = nextFishAt == null ? null : Math.max(0, nextFishAt - now)
  const ratio = remaining == null ? 0 : Math.min(1, remaining / total.current.ms)
  const label = remaining == null ? '—' : remaining === 0 ? 'Prêt' : `${(remaining / 1000).toFixed(1).replace('.', ',')} s`

  return (
    <div className="relative h-16 w-16 shrink-0" role="img" aria-label={`Prochain /fish : ${label}`}>
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={R} fill="none" strokeWidth="5" className="stroke-white/10" />
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-200 motion-safe:ease-linear"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - ratio)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-white">{label}</span>
    </div>
  )
}
