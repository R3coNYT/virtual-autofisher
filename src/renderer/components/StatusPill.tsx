import type { EngineState } from '../../shared/types'

const STYLES: Record<EngineState, { label: string; cls: string; dot: string }> = {
  idle: { label: 'Idle', cls: 'bg-slate-500/15 text-slate-300 border-slate-400/20', dot: 'bg-slate-400' },
  connecting: { label: 'Connecting…', cls: 'bg-slate-500/15 text-slate-300 border-slate-400/20', dot: 'bg-slate-400' },
  running: { label: 'Running', cls: 'bg-turquoise/15 text-turquoise border-turquoise/30', dot: 'bg-turquoise' },
  paused: { label: 'Paused', cls: 'bg-amber-400/15 text-amber-300 border-amber-300/30', dot: 'bg-amber-300' },
  resting: { label: 'Resting', cls: 'bg-blue-400/15 text-blue-300 border-blue-300/30', dot: 'bg-blue-300' },
  stopping: {
    label: 'Stopping…',
    cls: 'bg-amber-400/15 text-amber-300 border-amber-300/30',
    dot: 'bg-amber-300 motion-safe:animate-pulse'
  },
  captcha: {
    label: 'Captcha',
    cls: 'bg-red-500/20 text-red-300 border-red-400/40 motion-safe:animate-pulse',
    dot: 'bg-red-400'
  },
  error: { label: 'Error', cls: 'bg-red-500/15 text-red-300 border-red-400/30', dot: 'bg-red-400' }
}

export function StatusPill({ state }: { state: EngineState }): JSX.Element {
  const s = STYLES[state]
  return (
    <span
      role="status"
      aria-label={`Status: ${s.label}`}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${s.cls}`}
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}
