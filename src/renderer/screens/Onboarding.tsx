import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, ArrowRight, ChevronDown, Eye, EyeOff, Fish, Loader2, Lock, ShieldAlert } from 'lucide-react'
import type { SelfUser } from '../../shared/types'
import { Background } from '../components/Background'
import { useStore } from '../store'
import { cleanError, focusRing, primaryButton } from '../ui'

const RISKS = [
  "Using your user token goes against Discord's Terms of Service: your account may be banned.",
  'Virtual Fisher forbids macros: your progress may be reset or banned.',
  'The captcha must always be solved by you: the app never solves it for you.'
]

const STEPS = [
  'Open Discord in your browser (discord.com/app) and log in.',
  'Press F12 to open the developer tools.',
  'Go to the "Network" tab.',
  'Type "api" in the filter, then click a request.',
  'In the request headers, copy the value of "authorization".'
]

export default function Onboarding(): JSX.Element {
  const authError = useStore((s) => s.authError)
  const target = useStore((s) => s.target)
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [confirmed, setConfirmed] = useState<SelfUser | null>(null)
  const tokenId = useId()
  const helpId = useId()

  const canSubmit = accepted && token.trim().length > 0 && !busy
  const shownError = error ?? authError

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit) return
    const { setLoggingIn, setUser } = useStore.getState()
    setBusy(true)
    setError(null)
    setLoggingIn(true)
    try {
      const user = await window.api.auth.setToken(token.trim())
      setUser(user)
      setToken('')
      setConfirmed(user)
      useStore.setState({ authError: null })
    } catch (err) {
      setLoggingIn(false)
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  function proceed(): void {
    const s = useStore.getState()
    s.setLoggingIn(false)
    s.goto(target ? 'dashboard' : 'picker')
  }

  return (
    <Background>
      <main className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-5 px-6 py-10">
        <header className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-turquoise text-ocean shadow-lg shadow-accent/20">
            <Fish className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">Virtual AutoFisher</h1>
            <p className="text-sm text-slate-400">Connect your Discord account to get started.</p>
          </div>
        </header>

        <section aria-labelledby="risk-title" className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-5 backdrop-blur">
          <h2 id="risk-title" className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-300">
            <ShieldAlert className="h-4 w-4" aria-hidden /> Before you continue
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed text-slate-300">
            {RISKS.map((r) => (
              <li key={r} className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-amber-300" />
                {r}
              </li>
            ))}
          </ul>
          <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm font-medium text-white">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className={`h-4 w-4 cursor-pointer rounded border-white/20 bg-white/10 accent-accent ${focusRing}`}
            />
            I understand the risks
          </label>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          {confirmed ? (
            <div className="flex flex-col items-center gap-4 py-2 text-center">
              {confirmed.avatarUrl ? (
                <img
                  src={confirmed.avatarUrl}
                  alt=""
                  className="h-20 w-20 rounded-full border-2 border-accent/60 shadow-lg shadow-accent/20"
                />
              ) : (
                <div className="h-20 w-20 rounded-full border-2 border-accent/60 bg-white/10" />
              )}
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400">Logged in as</p>
                <p className="text-lg font-semibold text-white">{confirmed.username}</p>
              </div>
              <button type="button" onClick={proceed} autoFocus className={primaryButton}>
                Continue <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <label htmlFor={tokenId} className="mb-1.5 block text-sm font-medium text-slate-200">
                  Discord token
                </label>
                <div className="relative">
                  <input
                    id={tokenId}
                    type={show ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your token here"
                    aria-invalid={shownError ? true : undefined}
                    className={`w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-3.5 pr-11 font-mono text-sm text-white placeholder:font-sans placeholder:text-slate-500 transition hover:border-white/20 focus:border-accent/60 ${focusRing}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Hide the token' : 'Show the token'}
                    aria-pressed={show}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white ${focusRing}`}
                  >
                    {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
                  <Lock className="h-3 w-3 shrink-0 text-turquoise" aria-hidden />
                  Your token stays on this computer, encrypted, and is only sent to Discord.
                </p>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setHelpOpen((v) => !v)}
                  aria-expanded={helpOpen}
                  aria-controls={helpId}
                  className={`inline-flex items-center gap-1.5 rounded-md text-sm text-accent transition hover:text-turquoise ${focusRing}`}
                >
                  How do I find my token?
                  <ChevronDown className={`h-4 w-4 transition-transform ${helpOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                {helpOpen && (
                  <ol
                    id={helpId}
                    className="mt-3 list-decimal space-y-1.5 rounded-xl border border-white/10 bg-black/20 py-3 pl-8 pr-4 text-sm text-slate-300"
                  >
                    {STEPS.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>

              {shownError && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {shownError}
                </p>
              )}

              <button type="submit" disabled={!canSubmit} className={`${primaryButton} w-full`}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {busy ? 'Logging in…' : 'Log in'}
              </button>
              {!accepted && (
                <p className="text-center text-xs text-slate-500">
                  Check "I understand the risks" to enable login.
                </p>
              )}
            </form>
          )}
        </section>
      </main>
    </Background>
  )
}
