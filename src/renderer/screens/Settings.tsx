import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, ArrowLeft, Eye, EyeOff, FolderOpen, Loader2, LogOut } from 'lucide-react'
import type { Config, DeepPartial } from '../../shared/types'
import { Background } from '../components/Background'
import { cardCls } from '../components/StatCard'
import { BOUNDS, clampConfigPatch, commandMissing, parseNumberInput } from '../settingsBounds'
import { useStore } from '../store'
import { cleanError, focusRing, primaryButton } from '../ui'

const inputCls = `rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-white placeholder:text-slate-500 transition hover:border-white/20 focus:border-accent/60 disabled:opacity-40 ${focusRing}`
const secondaryButton = `inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`

/** Applies a patch immediately (clamped), updates the store with the config main returns. */
async function save(patch: DeepPartial<Config>): Promise<void> {
  const safe = clampConfigPatch(patch)
  if (Object.keys(safe).length === 0) return
  try {
    const config = await window.api.config.update(safe)
    useStore.setState({ config })
  } catch (e) {
    useStore.getState().pushToast({ level: 'error', message: cleanError(e) })
  }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <section className={`${cardCls} p-5`} aria-label={title}>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      <div className="mt-3 divide-y divide-white/5">{children}</div>
    </section>
  )
}

function Row({ label, help, missing, children }: { label: string; help?: string; missing?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm text-slate-200">{label}</p>
        {help && <p className="text-xs text-slate-500">{help}</p>}
        {missing && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-300">
            <AlertCircle className="h-3 w-3 shrink-0" aria-hidden /> Command unavailable
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition ${
        checked ? 'border-accent/60 bg-accent/30' : 'border-white/15 bg-white/10'
      } ${focusRing}`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${checked ? 'left-[1.375rem] bg-accent' : 'left-0.5 bg-slate-400'}`}
      />
    </button>
  )
}

const fmt = (n: number): string => String(n)

/** Number input committed on blur / Enter (not on every keystroke), clamped to [min, max]. */
function NumField(props: {
  label: string
  value: number
  min: number
  max?: number
  unit?: string
  integer?: boolean
  onCommit: (n: number) => void
  disabled?: boolean
}): JSX.Element {
  const { value, min, max, onCommit } = props
  const [draft, setDraft] = useState(fmt(value))
  useEffect(() => setDraft(fmt(value)), [value])

  function commit(): void {
    const n = parseNumberInput(draft)
    if (n === null) return setDraft(fmt(value))
    const v = Math.min(max ?? Infinity, Math.max(min, props.integer ? Math.round(n) : n))
    setDraft(fmt(v))
    if (v !== value) onCommit(v)
  }

  return (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      <input
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        value={draft}
        disabled={props.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={`${inputCls} w-20 text-right tabular-nums`}
      />
      {props.unit}
    </label>
  )
}

function TextField(props: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const commit = (): void => {
    const v = draft.trim()
    setDraft(v)
    if (v !== props.value) props.onCommit(v)
  }
  return (
    <input
      type="text"
      aria-label={props.label}
      value={draft}
      placeholder={props.placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={`${inputCls} w-48`}
    />
  )
}

function Segmented<T extends string | number>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label={props.label} className="inline-flex rounded-lg border border-white/10 bg-black/20 p-0.5">
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          onClick={() => o.value !== props.value && props.onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${focusRing} ${
            o.value === props.value ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function AccountSection(): JSX.Element {
  const user = useStore((s) => s.user)
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tokenId = useId()

  async function changeToken(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const me = await window.api.auth.setToken(token.trim())
      const s = useStore.getState()
      s.setUser(me)
      s.pushToast({ level: 'success', message: `Token updated: logged in as ${me.username}. Start fishing again.` })
      setToken('')
      setEditing(false)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  async function logout(): Promise<void> {
    setBusy(true)
    try {
      await window.api.auth.logout()
      const s = useStore.getState()
      s.setUser(null)
      s.setLoggingIn(false)
      s.goto('onboarding')
    } catch (err) {
      useStore.getState().pushToast({ level: 'error', message: cleanError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Account">
      <Row label={user ? `Logged in as ${user.username}` : 'Discord account'} help="The token stays encrypted on this computer.">
        <button type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing} className={secondaryButton}>
          Change token
        </button>
        <button type="button" onClick={() => void logout()} disabled={busy} className={secondaryButton}>
          <LogOut className="h-4 w-4" aria-hidden /> Log out
        </button>
      </Row>
      {editing && (
        <form onSubmit={changeToken} className="space-y-3 py-3" noValidate>
          <label htmlFor={tokenId} className="block text-sm text-slate-200">
            New Discord token
          </label>
          <div className="relative">
            <input
              id={tokenId}
              type={show ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the new token here"
              className={`${inputCls} w-full py-2.5 pr-11 font-mono`}
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
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <button type="submit" disabled={!token.trim() || busy} className={primaryButton}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Checking…' : 'Save token'}
          </button>
          <p className="text-xs text-slate-500">Fishing in progress is stopped once the new token is accepted.</p>
        </form>
      )}
    </Section>
  )
}

export default function Settings(): JSX.Element {
  const cfg = useStore((s) => s.config)
  const commands = useStore((s) => s.commands)
  const goto = useStore((s) => s.goto)
  const missing = (name: string): boolean => commandMissing(commands, name)

  // authoritative values may have been changed elsewhere: refresh once when the screen opens
  useEffect(() => {
    window.api.config
      .get()
      .then((config) => useStore.setState({ config }))
      .catch(() => undefined)
  }, [])

  const { fishing, sell, buffs, bait, profile, daily, quests, breaks, notifications } = cfg

  return (
    <Background>
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-6 py-6">
        <header className="flex items-center gap-3">
          <button type="button" onClick={() => goto('dashboard')} className={secondaryButton}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back
          </button>
          <h1 className="text-xl font-semibold tracking-tight text-white">Settings</h1>
          <p className="ml-auto text-xs text-slate-500">Applied immediately</p>
        </header>

        <Section title="Fishing">
          <Row label="Base delay between two /fish" help="Minimum 2s">
            <NumField label="Base delay" value={fishing.baseCooldownSec} {...BOUNDS.baseCooldownSec} unit="s" onCommit={(n) => void save({ fishing: { baseCooldownSec: n } })} />
          </Row>
          <Row label="Random variation (±)" help="From 0 to 5s">
            <NumField label="Random variation" value={fishing.jitterSec} {...BOUNDS.jitterSec} unit="s" onCommit={(n) => void save({ fishing: { jitterSec: n } })} />
          </Row>
          <Row label="Minimum gap between two commands" help="All commands combined, minimum 2s">
            <NumField label="Minimum gap" value={fishing.minGapSec} {...BOUNDS.minGapSec} unit="s" onCommit={(n) => void save({ fishing: { minGapSec: n } })} />
          </Row>
        </Section>

        <Section title="Selling">
          <Row label="Auto sell (/sell all)" missing={missing('sell')}>
            <Toggle label="Auto sell" checked={sell.enabled} onChange={(v) => void save({ sell: { enabled: v } })} />
          </Row>
          <Row label="Trigger">
            <Segmented
              label="Sell trigger"
              value={sell.mode}
              options={[
                { value: 'catches', label: 'Catches' },
                { value: 'minutes', label: 'Minutes' }
              ]}
              onChange={(v) => void save({ sell: { mode: v } })}
            />
          </Row>
          <Row label={sell.mode === 'catches' ? 'Sell every N catches' : 'Sell every N minutes'} help="Minimum 1">
            <NumField label="Value of N" value={sell.every} {...BOUNDS.sellEvery} integer onCommit={(n) => void save({ sell: { every: n } })} />
          </Row>
        </Section>

        <Section title="Buffs and bait">
          <Row label="Auto buffs (fish + treasure)" missing={missing('buy')}>
            <Toggle label="Auto buffs" checked={buffs.enabled} onChange={(v) => void save({ buffs: { enabled: v } })} />
          </Row>
          <Row label="Buff length">
            <Segmented
              label="Buff length"
              value={buffs.lengthMin}
              options={[
                { value: 5, label: '5 min' },
                { value: 20, label: '20 min' }
              ]}
              onChange={(v) => void save({ buffs: { lengthMin: v } })}
            />
          </Row>
          <Row label="Auto buy bait" missing={missing('buy')}>
            <Toggle label="Auto buy bait" checked={bait.enabled} onChange={(v) => void save({ bait: { enabled: v } })} />
          </Row>
          <Row label="Bait to buy" help="Exact bait name in /buy">
            <TextField label="Bait name" value={bait.name} placeholder="e.g. Worm" onCommit={(v) => void save({ bait: { name: v } })} />
          </Row>
          <Row label="Amount computed automatically" help="From the buff length and the fishing delay">
            <Toggle label="Automatic amount" checked={bait.autoAmount} onChange={(v) => void save({ bait: { autoAmount: v } })} />
          </Row>
          {!bait.autoAmount && (
            <Row label="Amount per purchase">
              <NumField label="Bait amount" value={bait.amount} {...BOUNDS.baitAmount} integer onCommit={(n) => void save({ bait: { amount: Math.round(n) } })} />
            </Row>
          )}
        </Section>

        <Section title="Profile, daily and quests">
          <Row label="Refresh the profile every" help="Inventory and statistics, minimum 1 min" missing={missing('profile')}>
            <NumField label="Profile interval" value={profile.refreshMin} {...BOUNDS.refreshMin} unit="min" onCommit={(n) => void save({ profile: { refreshMin: n } })} />
          </Row>
          <Row label="Daily reward (/daily)" missing={missing('daily')}>
            <Toggle label="Auto daily" checked={daily.enabled} onChange={(v) => void save({ daily: { enabled: v } })} />
          </Row>
          <Row label="Quest tracking (/quests)" help="Read only: shown on the dashboard" missing={missing('quests')}>
            <Toggle label="Quest tracking" checked={quests.enabled} onChange={(v) => void save({ quests: { enabled: v } })} />
          </Row>
        </Section>

        <Section title="Humanization" hint="Breaks and session limit, for a less regular activity.">
          <Row label="Regular breaks">
            <Toggle label="Regular breaks" checked={breaks.enabled} onChange={(v) => void save({ breaks: { enabled: v } })} />
          </Row>
          <Row label="Fishing before each break">
            <NumField label="Fishing time" value={breaks.workMin} {...BOUNDS.breakMin} unit="min" disabled={!breaks.enabled} onCommit={(n) => void save({ breaks: { workMin: n } })} />
            <NumField label="Fishing time variation" value={breaks.workJitterMin} {...BOUNDS.breakMin} unit="± min" disabled={!breaks.enabled} onCommit={(n) => void save({ breaks: { workJitterMin: n } })} />
          </Row>
          <Row label="Break length">
            <NumField label="Break length" value={breaks.restMin} {...BOUNDS.breakMin} unit="min" disabled={!breaks.enabled} onCommit={(n) => void save({ breaks: { restMin: n } })} />
            <NumField label="Break length variation" value={breaks.restJitterMin} {...BOUNDS.breakMin} unit="± min" disabled={!breaks.enabled} onCommit={(n) => void save({ breaks: { restJitterMin: n } })} />
          </Row>
          <Row label="Stop automatically after" help="0 = no limit">
            <NumField label="Session limit" value={cfg.sessionLimitH} {...BOUNDS.sessionLimitH} unit="h" onCommit={(n) => void save({ sessionLimitH: n })} />
          </Row>
        </Section>

        <Section title="Notifications">
          <Row label="Captcha notification">
            <Toggle label="Captcha notification" checked={notifications.captcha} onChange={(v) => void save({ notifications: { captcha: v } })} />
          </Row>
          <Row label="Sound with the notification">
            <Toggle label="Sound" checked={notifications.sound} onChange={(v) => void save({ notifications: { sound: v } })} />
          </Row>
          <Row label="Level up">
            <Toggle label="Level-up notification" checked={notifications.levelUp} onChange={(v) => void save({ notifications: { levelUp: v } })} />
          </Row>
          <Row label="Rare fish">
            <Toggle label="Rare fish notification" checked={notifications.rareFish} onChange={(v) => void save({ notifications: { rareFish: v } })} />
          </Row>
        </Section>

        <AccountSection />

        <Section title="Advanced">
          <Row label="Closing the window minimizes the app to the system tray" help="Quit from the tray icon menu (right click)">
            <Toggle label="Minimize to the system tray" checked={cfg.ui.closeToTray} onChange={(v) => void save({ ui: { closeToTray: v } })} />
          </Row>
          <Row
            label="Capture mode"
            help="Saves the bot's raw messages in the data folder's captures directory (%APPDATA%\virtual-autofisher\captures), to improve recognition. They may contain your username."
          >
            <Toggle label="Capture mode" checked={cfg.capture} onChange={(v) => void save({ capture: v })} />
          </Row>
          <Row label="Data folder" help="Configuration, logs, session summaries and captures">
            <button
              type="button"
              onClick={() =>
                window.api.app.openDataDir().catch((e) => useStore.getState().pushToast({ level: 'error', message: cleanError(e) }))
              }
              className={secondaryButton}
            >
              <FolderOpen className="h-4 w-4" aria-hidden /> Open the data folder
            </button>
          </Row>
        </Section>
      </main>
    </Background>
  )
}
