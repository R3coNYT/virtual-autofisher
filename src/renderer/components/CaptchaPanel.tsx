import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { AlertCircle, CheckCircle2, ImageOff, Loader2, RefreshCw, ShieldAlert, Square } from 'lucide-react'
import { canRegen } from '../settingsBounds'
import { useStore } from '../store'
import { cleanError, focusRing, primaryButton } from '../ui'

const SENDING_TIMEOUT_MS = 10_000
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/**
 * Modal shown whenever the engine is in captcha. It cannot be dismissed (no close button, Escape ignored)
 * and never sends anything by itself: only Valider / Nouvelle image, clicked or confirmed by the user, do.
 * « Arrêter la pêche » (false positive) stops the engine without sending anything; main then hides the panel.
 */
export function CaptchaPanel(): JSX.Element | null {
  const captcha = useStore((s) => s.captcha)
  const regenAvailable = useStore((s) => canRegen(s.commands))
  if (!captcha) return null
  return <Modal key="captcha" captcha={captcha} regenAvailable={regenAvailable} />
}

function Modal({ captcha, regenAvailable }: { captcha: NonNullable<ReturnType<typeof useStore.getState>['captcha']>; regenAvailable: boolean }): JSX.Element {
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [noReply, setNoReply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imgFailed, setImgFailed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const solved = captcha.solved === true
  const locked = sending || solved || stopping
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // a new captcha.show (new image, or the bot rejected the answer) ends the "Envoi…" state
  useEffect(() => {
    setSending(false)
    setNoReply(false)
    setImgFailed(false)
    input.current?.focus()
    input.current?.select()
  }, [captcha])

  useEffect(() => {
    if (!sending || solved) return
    // no captcha.show/hide after 10 s: allow another try, with a hint
    const t = setTimeout(() => {
      setSending(false)
      setNoReply(true)
    }, SENDING_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [sending, solved])

  async function run(fn: () => Promise<void>, onSent?: () => void): Promise<void> {
    setError(null)
    setNoReply(false)
    setSending(true)
    try {
      await fn()
      onSent?.()
    } catch (e) {
      setSending(false)
      setError(cleanError(e))
    }
  }

  function stop(): void {
    setError(null)
    setStopping(true)
    window.api.engine.stop(false).catch((e) => {
      setStopping(false)
      setError(cleanError(e))
    })
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    const a = answer.trim()
    if (!a || locked) return
    void run(() => window.api.captcha.submit(a), () => setAnswer(''))
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') return e.preventDefault() // not dismissable
    if (e.key !== 'Tab' || !box.current) return
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) return e.preventDefault()
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !box.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // a click on the backdrop must not drop focus out of the modal
        if (e.target === e.currentTarget) {
          e.preventDefault()
          input.current?.focus()
        }
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-2xl border bg-ocean p-6 shadow-2xl ${solved ? 'border-turquoise/40 shadow-turquoise/10' : 'border-red-400/40 shadow-red-500/10'}`}
      >
        <header className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl ${solved ? 'bg-turquoise/15 text-turquoise' : 'bg-red-500/15 text-red-300'}`}
          >
            {solved ? <CheckCircle2 className="h-5 w-5" aria-hidden /> : <ShieldAlert className="h-5 w-5" aria-hidden />}
          </span>
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-white">
              {solved ? 'Captcha résolu' : 'Captcha à résoudre'}
            </h2>
            <p className="text-xs text-slate-400">
              {solved ? 'La pêche reprend dans quelques secondes.' : "La pêche est en pause. Rien n'est envoyé sans votre validation."}
            </p>
          </div>
        </header>

        {captcha.imageUrl && !imgFailed ? (
          <img
            src={captcha.imageUrl}
            alt="Image du captcha Virtual Fisher"
            onError={() => setImgFailed(true)}
            className="max-h-64 w-full rounded-xl border border-white/10 bg-black/30 object-contain"
          />
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-4 text-sm text-slate-400">
            <ImageOff className="h-4 w-4 shrink-0" aria-hidden />
            {captcha.imageUrl ? "L'image n'a pas pu être chargée : essayez « Nouvelle image »." : 'Aucune image : lisez le message du bot ci-dessous.'}
          </p>
        )}

        {captcha.text && (
          <p
            className={`whitespace-pre-line rounded-xl border px-3 py-2.5 text-sm ${solved ? 'border-turquoise/30 bg-turquoise/10 text-turquoise' : 'border-white/10 bg-white/5 text-slate-200'}`}
            aria-live="polite"
          >
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Dernier message du bot</span>
            {captcha.text}
          </p>
        )}

        <form onSubmit={submit} className="space-y-3" noValidate>
          <input
            ref={input}
            autoFocus
            type="text"
            disabled={solved || stopping}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Réponse au captcha"
            placeholder="Tapez la réponse"
            className={`w-full rounded-xl border border-white/10 bg-black/20 px-3.5 py-2.5 text-base text-white placeholder:text-slate-500 transition hover:border-white/20 focus:border-accent/60 ${focusRing}`}
          />
          {noReply && !error && !solved && (
            <p role="status" className="text-sm text-amber-300">
              Pas de réponse, réessaie.
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={!answer.trim() || locked} className={primaryButton}>
              {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {sending ? 'Envoi…' : 'Valider'}
            </button>
            {regenAvailable && (
              <button
                type="button"
                disabled={locked}
                onClick={() => void run(() => window.api.captcha.regen())}
                className={`inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                <RefreshCw className="h-4 w-4" aria-hidden /> Nouvelle image
              </button>
            )}
            {!solved && (
              <button
                type="button"
                disabled={stopping}
                onClick={stop}
                title="Faux captcha ? Arrête la session sans rien envoyer"
                className={`ml-auto inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                {stopping ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-4 w-4" aria-hidden />}
                Arrêter la pêche
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
