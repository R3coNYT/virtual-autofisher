import { useEffect } from 'react'
import { create } from 'zustand'
import type { ConnectionStatus } from '../shared/ipc'
import { DEFAULT_CONFIG } from '../shared/types'
import type { Config, DeepPartial, EngineState, GameSnapshot, LogEntry, SelfUser, SlashCommandInfo } from '../shared/types'
import { applyGamePatch, emptySnapshot } from './applyGamePatch'
import { appendCapped } from './logBuffer'
import { resolveFirstScreen } from './resolveFirstScreen'

export type Screen = 'splash' | 'onboarding' | 'picker' | 'dashboard' | 'settings'
export type Target = { guildId: string; channelId: string }
export type CaptchaState = { imageUrl?: string; text?: string } | null
/** Human names of the chosen server/channel, kept alongside the ids (display only). */
export type TargetNames = { guildId: string; channelId: string; guildName: string; channelName: string }
export type Toast = { id: number; level: 'info' | 'success' | 'error'; message: string }

type State = {
  screen: Screen
  user: SelfUser | null
  target: Target | null
  targetNames: TargetNames | null
  /** Slash commands discovered by the engine (empty until known). */
  commands: SlashCommandInfo[]
  connection: ConnectionStatus | null
  /** Detail shown on the splash while waiting (e.g. network retry). */
  connectionMessage: string | null
  authError: string | null
  /** true while the user is going through the onboarding login flow (confirmation card). */
  loggingIn: boolean
  engineState: EngineState
  game: GameSnapshot
  log: LogEntry[]
  captcha: CaptchaState
  config: Config
  toasts: Toast[]
}

type Actions = {
  goto(screen: Screen): void
  applyPatch(patch: DeepPartial<GameSnapshot>): void
  appendLog(entries: LogEntry[]): void
  setUser(user: SelfUser | null): void
  setTarget(target: Target | null): void
  setTargetNames(names: TargetNames): void
  setLoggingIn(v: boolean): void
  pushToast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
}

let toastId = 0
const NAMES_KEY = 'vaf.targetNames'

function loadTargetNames(): TargetNames | null {
  try {
    const raw = localStorage.getItem(NAMES_KEY)
    return raw ? (JSON.parse(raw) as TargetNames) : null
  } catch {
    return null
  }
}

export const useStore = create<State & Actions>((set) => ({
  screen: 'splash',
  user: null,
  target: null,
  targetNames: loadTargetNames(),
  commands: [],
  connection: null,
  connectionMessage: null,
  authError: null,
  loggingIn: false,
  engineState: 'idle',
  game: emptySnapshot(),
  log: [],
  captcha: null,
  config: DEFAULT_CONFIG,
  toasts: [],

  goto: (screen) => set({ screen }),
  applyPatch: (patch) => set((s) => ({ game: applyGamePatch(s.game, patch) })),
  appendLog: (entries) => set((s) => ({ log: appendCapped(s.log, entries) })),
  setUser: (user) => set({ user }),
  setTarget: (target) => set({ target }),
  setTargetNames: (names) => {
    set({ targetNames: names })
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(names))
    } catch {
      /* storage unavailable: names stay in memory only */
    }
  },
  setLoggingIn: (loggingIn) => set({ loggingIn }),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: ++toastId }].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Subscribes the store to main-process events and resolves the first screen. Call once from <App />. */
export function useApiEvents(): void {
  useEffect(() => {
    const api = window.api
    const st = useStore
    let cancelled = false

    /** Reads the auth state (incl. main's buffered connection status) and routes. */
    const syncFromMain = async (): Promise<void> => {
      try {
        const status = await api.auth.status()
        if (cancelled) return
        const s = st.getState()
        s.setUser(status.user)
        s.setTarget(status.target)
        const next = resolveFirstScreen(status)
        if (next.screen === 'splash') {
          st.setState({ connectionMessage: next.message ?? null })
          if (s.screen === 'splash') return
          if (s.screen === 'onboarding' && s.loggingIn) return
          s.goto('splash')
        } else if (next.screen === 'onboarding') {
          st.setState({ authError: next.error ?? s.authError })
          if (s.screen === 'splash') s.goto('onboarding')
        } else if (s.screen === 'splash' || (s.screen === 'onboarding' && !s.loggingIn)) {
          s.goto(next.screen)
        }
      } catch {
        if (!cancelled && st.getState().screen === 'splash') st.getState().goto('onboarding')
      }
    }

    const offs = [
      api.on('engine.state', ({ state, info }) => {
        st.setState((s) => ({
          engineState: state,
          captcha: state === 'captcha' ? { imageUrl: info?.captchaImageUrl, text: info?.captchaText } : s.captcha
        }))
      }),
      api.on('engine.commands', (commands) => st.setState({ commands })),
      api.on('game.patch', (p) => st.getState().applyPatch(p)),
      api.on('log.append', (e) => st.getState().appendLog(e)),
      api.on('captcha.show', (c) => st.setState({ captcha: { imageUrl: c.imageUrl, text: c.text } })),
      api.on('captcha.hide', () => st.setState({ captcha: null })),
      api.on('toast', (t) => st.getState().pushToast(t)),
      api.on('connection.status', ({ status }) => {
        st.setState({ connection: status })
        if (status === 'connected') st.setState({ authError: null })
        if (status !== 'connecting') void syncFromMain()
        else st.setState({ connectionMessage: null })
      })
    ]

    api.config
      .get()
      .then((config) => !cancelled && st.setState({ config }))
      .catch(() => undefined)
    api.engine
      .commands()
      .then((commands) => !cancelled && st.setState({ commands }))
      .catch(() => undefined)
    void syncFromMain()

    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [])
}
