import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useStore, type Toast } from '../store'
import { focusRing } from '../ui'

const DURATION_MS = { info: 6_000, success: 6_000, error: 10_000 } as const

const TONE: Record<Toast['level'], { cls: string; icon: JSX.Element }> = {
  info: { cls: 'border-accent/30 text-slate-100', icon: <Info className="h-4 w-4 shrink-0 text-accent" aria-hidden /> },
  success: { cls: 'border-turquoise/30 text-slate-100', icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-turquoise" aria-hidden /> },
  error: { cls: 'border-red-400/40 text-red-100', icon: <AlertCircle className="h-4 w-4 shrink-0 text-red-300" aria-hidden /> }
}

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), DURATION_MS[toast.level])
    return () => clearTimeout(t)
  }, [toast.id, toast.level, dismiss])
  const tone = TONE[toast.level]
  return (
    <div className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-ocean/95 px-3.5 py-3 text-sm shadow-xl backdrop-blur ${tone.cls}`}>
      {tone.icon}
      <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Fermer la notification"
        className={`-m-1 rounded-md p-1 text-slate-400 transition hover:text-white ${focusRing}`}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

/** Stacked notifications, bottom-right. Rendered outside the inert wrapper so they stay readable during a captcha. */
export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
