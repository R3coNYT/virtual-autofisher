import { Loader2 } from 'lucide-react'

export function Splash({ label = 'Connexion à Discord…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-300" role="status" aria-live="polite">
      <Loader2 className="h-8 w-8 animate-spin text-accent" aria-hidden />
      <p className="text-sm">{label}</p>
    </div>
  )
}
