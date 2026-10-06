import { ChevronDown, Hash, Loader2, Pause, Play, Settings, Square } from 'lucide-react'
import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { formatDuration } from '../format'
import { useStore } from '../store'
import { cleanError, focusRing } from '../ui'
import { useNow } from '../useNow'
import { StatusPill } from './StatusPill'

const ctl = `inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`
const GO = 'border-turquoise/40 bg-turquoise/15 text-turquoise hover:bg-turquoise/25'
const PAUSE = 'border-amber-300/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
const STOP = 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
const ICON = 'h-3.5 w-3.5'

function Control(props: {
  label: string
  icon: ReactNode
  run: () => Promise<void>
  tone: string
  title?: string
  disabled?: boolean
}): JSX.Element {
  const [pending, setPending] = useState(false)
  const onClick = (): void => {
    setPending(true)
    props
      .run()
      .catch((e) => useStore.getState().pushToast({ level: 'error', message: cleanError(e) }))
      .finally(() => setPending(false))
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || props.disabled}
      title={props.title}
      className={`${ctl} ${props.tone}`}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

const PAUSE_REASONS: Record<string, string> = {
  user: 'Paused by you',
  network: 'Connection to Discord lost',
  noResponse: 'Virtual Fisher is not responding',
  exception: 'Unexpected error'
}

/** Why the engine is paused, in error, or stopped on its own (session limit). */
function StateReason(): JSX.Element | null {
  const state = useStore((s) => s.engineState)
  const reason = useStore((s) => s.engineInfo.reason)
  if (!reason || (state !== 'paused' && state !== 'error' && state !== 'idle')) return null
  const text = state === 'paused' ? (PAUSE_REASONS[reason] ?? reason) : reason
  return (
    <span className={`max-w-[22rem] truncate text-xs ${state === 'error' ? 'text-red-300' : 'text-slate-400'}`} title={text}>
      {text}
    </span>
  )
}

function SessionClock(): JSX.Element | null {
  const startedAt = useStore((s) => s.game.session.startedAt)
  const now = useNow()
  if (startedAt == null) return null
  return (
    <span className="text-sm tabular-nums text-slate-300" title="Session duration">
      {formatDuration(now - startedAt)}
    </span>
  )
}

export const TopBar = memo(function TopBar(): JSX.Element {
  const state = useStore((s) => s.engineState)
  const names = useStore((s) => s.targetNames)
  const target = useStore((s) => s.target)
  const goto = useStore((s) => s.goto)
  const engine = window.api.engine
  const guildLabel = names && names.guildId === target?.guildId ? names.guildName : (target?.guildId ?? 'No server')
  const channelLabel = names && names.channelId === target?.channelId ? names.channelName : (target?.channelId ?? '—')

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-ocean/60 px-5 py-3 backdrop-blur">
      <button
        type="button"
        onClick={() => goto('picker')}
        title="Change server or channel"
        className={`flex min-w-0 max-w-[18rem] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white transition hover:bg-white/10 ${focusRing}`}
      >
        <span className="truncate font-medium">{guildLabel}</span>
        <Hash className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <span className="truncate text-slate-300">{channelLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
      </button>
      <StatusPill state={state} />
      <StateReason />
      <SessionClock />
      <div className="ml-auto flex items-center gap-2">
        {state === 'connecting' && (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Connecting…
          </span>
        )}
        {(state === 'idle' || state === 'error') && (
          <Control label="Start" icon={<Play className={ICON} aria-hidden />} run={() => engine.start()} tone={GO} />
        )}
        {(state === 'running' || state === 'resting') && (
          <Control label="Pause" icon={<Pause className={ICON} aria-hidden />} run={() => engine.pause()} tone={PAUSE} />
        )}
        {state === 'stopping' && (
          // final /profile + /quests under way: nothing to pause; a second stop forces the halt
          <Control label="Pause" icon={<Pause className={ICON} aria-hidden />} run={async () => undefined} tone={PAUSE} disabled />
        )}
        {state === 'paused' && (
          <Control label="Resume" icon={<Play className={ICON} aria-hidden />} run={() => engine.resume()} tone={GO} />
        )}
        {state === 'stopping' ? (
          <Control
            label="Force stop"
            title="Stop right now, without waiting for /profile and /quests"
            icon={<Square className={ICON} aria-hidden />}
            run={() => engine.stop(false)}
            tone={STOP}
          />
        ) : (
          state !== 'idle' &&
          state !== 'error' && (
            <Control
              label="Stop"
              title="Graceful stop: /profile and /quests, then stop"
              icon={<Square className={ICON} aria-hidden />}
              run={() => engine.stop(true)}
              tone={STOP}
            />
          )
        )}
        <button
          type="button"
          onClick={() => goto('settings')}
          aria-label="Settings"
          title="Settings"
          className={`rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white ${focusRing}`}
        >
          <Settings className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </header>
  )
})
