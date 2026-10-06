import { memo } from 'react'
import type { RareCounts } from '../../shared/types'
import { cardCls } from './StatCard'

const RARES: { key: keyof RareCounts; label: string; cls: string }[] = [
  { key: 'gold', label: 'Gold', cls: 'text-yellow-300' },
  { key: 'emerald', label: 'Emerald', cls: 'text-emerald-300' },
  { key: 'lava', label: 'Lava', cls: 'text-orange-400' },
  { key: 'diamond', label: 'Diamond', cls: 'text-cyan-300' }
]

export const RareFishGrid = memo(function RareFishGrid({ session, total }: { session: RareCounts; total: RareCounts }): JSX.Element {
  return (
    <section aria-label="Poissons rares" className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {RARES.map(({ key, label, cls }) => (
        <div key={key} className={`${cardCls} p-3`}>
          <p className={`text-xs font-semibold ${cls}`}>{label}</p>
          <p className="mt-1 text-xl font-semibold text-white">
            +{session[key]}
            <span className="ml-1 text-xs font-normal text-slate-400">session</span>
          </p>
          <p className="text-xs text-slate-400">Total : {total[key]}</p>
        </div>
      ))}
    </section>
  )
})
