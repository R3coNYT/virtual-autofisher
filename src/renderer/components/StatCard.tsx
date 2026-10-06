import type { ReactNode } from 'react'

export const cardCls = 'rounded-2xl border border-white/10 bg-white/5 backdrop-blur'

type Props = { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode; aside?: ReactNode }

export function StatCard({ label, value, sub, children, aside }: Props): JSX.Element {
  return (
    <section className={`${cardCls} flex min-w-0 items-center justify-between gap-3 p-4`} aria-label={label}>
      <div className="min-w-0 flex-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</h3>
        <p className="mt-1 truncate text-2xl font-semibold text-white">{value}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-slate-400">{sub}</p>}
        {children}
      </div>
      {aside}
    </section>
  )
}
