import { CalendarClock, Fish, Map, Package } from 'lucide-react'
import { memo } from 'react'
import type { ReactNode } from 'react'
import type { GameSnapshot } from '../../shared/types'
import { formatDuration, questRatio } from '../format'
import { useNow } from '../useNow'
import { cardCls } from './StatCard'

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-slate-500" aria-hidden>
        {icon}
      </span>
      <span className="text-slate-400">{label}</span>
      <span className="ml-auto truncate font-medium text-white">{value}</span>
    </div>
  )
}

type Props = { account: GameSnapshot['account']; quests: GameSnapshot['quests']; nextDailyAt: number | null }

export const SidePanel = memo(function SidePanel({ account, quests, nextDailyAt }: Props): JSX.Element {
  const now = useNow()
  const daily = nextDailyAt == null ? '—' : nextDailyAt <= now ? 'Disponible' : formatDuration(nextDailyAt - now)
  return (
    <aside aria-label="Informations du compte" className={`${cardCls} flex flex-col gap-4 p-4`}>
      <div className="flex flex-col gap-2">
        <Row icon={<Fish className="h-4 w-4" />} label="Canne" value={account.rod ?? '—'} />
        <Row icon={<Map className="h-4 w-4" />} label="Biome" value={account.biome ?? '—'} />
        <Row
          icon={<Package className="h-4 w-4" />}
          label="Appât"
          value={account.bait ? `${account.bait.name} ×${account.bait.count}` : '—'}
        />
        <Row icon={<CalendarClock className="h-4 w-4" />} label="Prochain daily" value={daily} />
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Quêtes du jour</h3>
        {quests.length === 0 && <p className="text-xs text-slate-500">Aucune quête connue.</p>}
        <ul className="flex flex-col gap-2.5">
          {quests.map((q, i) => (
            <li key={`${i}-${q.label}`}>
              <div className="flex justify-between gap-2 text-xs">
                <span className={q.done ? 'text-turquoise' : 'text-slate-200'}>{q.label}</span>
                <span className="shrink-0 text-slate-400">{q.done ? 'Terminée' : q.progress}</span>
              </div>
              <div
                role="progressbar"
                aria-label={q.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(questRatio(q.progress, q.done) * 100)}
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"
              >
                <div className="h-full rounded-full bg-turquoise" style={{ width: `${questRatio(q.progress, q.done) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
})
