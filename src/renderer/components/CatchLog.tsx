import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry } from '../../shared/types'
import { logFilter } from '../format'
import type { LogFilter } from '../format'
import { focusRing } from '../ui'
import { cardCls } from './StatCard'

const PAGE = 200
const FILTERS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'Tout' },
  { id: 'catch', label: 'Prises' },
  { id: 'trade', label: 'Achats/ventes' },
  { id: 'system', label: 'Système' }
]
const TYPE_CLS: Record<LogEntry['type'], string> = {
  catch: 'text-slate-200',
  trade: 'text-turquoise',
  system: 'text-slate-400',
  error: 'text-red-300',
  unknown: 'text-slate-500'
}

const time = (at: number): string => new Date(at).toLocaleTimeString('fr-FR')

export function CatchLog({ log, compact }: { log: LogEntry[]; compact: boolean }): JSX.Element {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [limit, setLimit] = useState(PAGE)
  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const filtered = useMemo(() => log.filter((e) => logFilter(e, filter)), [log, filter])
  const shown = filtered.slice(-limit)
  const hidden = filtered.length - shown.length

  useLayoutEffect(() => {
    const el = box.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [filtered])

  function onScroll(): void {
    const el = box.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  return (
    <section className={`${cardCls} flex min-h-0 flex-1 flex-col`} aria-label="Journal des prises">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-white">Journal</h3>
        <div role="group" aria-label="Filtrer le journal" className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id)
                setLimit(PAGE)
                atBottom.current = true
              }}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${focusRing} ${
                filter === f.id ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:bg-white/10 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-1" role="log" aria-live="off">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE)}
            className={`mx-auto my-2 block rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/10 ${focusRing}`}
          >
            Voir plus ({hidden})
          </button>
        )}
        {shown.length === 0 && <p className="p-4 text-sm text-slate-500">Aucune entrée pour le moment.</p>}
        <ul>
          {shown.map((e) => (
            <li
              key={e.id}
              className={`flex gap-3 rounded-md px-2 text-sm ${compact ? 'py-0.5' : 'py-1.5'} ${
                e.highlight ? 'bg-accent/15 font-semibold text-accent' : TYPE_CLS[e.type]
              }`}
            >
              <time className="shrink-0 text-xs leading-5 text-slate-500" dateTime={new Date(e.at).toISOString()}>
                {time(e.at)}
              </time>
              <span className="min-w-0 break-words">{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
