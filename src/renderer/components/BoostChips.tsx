import { Zap } from 'lucide-react'
import type { GameSnapshot } from '../../shared/types'
import { formatDuration } from '../format'
import { useNow } from '../useNow'

export function BoostChips({ boosts }: { boosts: GameSnapshot['boosts'] }): JSX.Element {
  const now = useNow()
  const active = boosts.filter((b) => b.endsAt > now)
  return (
    <section aria-label="Active boosts" className="flex flex-wrap items-center gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">Boosts</h3>
      {active.length === 0 && <span className="text-xs text-slate-500">No active boost</span>}
      {active.map((b) => (
        <span
          key={b.name}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent"
        >
          <Zap className="h-3 w-3" aria-hidden />
          <span className="font-medium">{b.name}</span>
          <span className="text-slate-300">{formatDuration(b.endsAt - now)}</span>
        </span>
      ))}
    </section>
  )
}
