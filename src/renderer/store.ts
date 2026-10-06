import { useEffect } from 'react'
import { create } from 'zustand'
import type { ConnectionStatus } from '../shared/ipc'
import { DEFAULT_CONFIG } from '../shared/types'
import type { Config, DeepPartial, EngineState, GameSnapshot, LogEntry, SelfUser } from '../shared/types'
import { applyGamePatch, emptySnapshot } from './applyGamePatch'

export type Screen = 'splash' | 'onboarding' | 'picker' | 'dashboard' | 'settings'
export type Target = { guildId: string; channelId: string }
export type CaptchaState = { imageUrl?: string; text?: string } | null
export type Toast = { id: number; level: 'info' | 'success' | 'error'; message: string }

export const MAX_LOG = 500

type State = {
  screen: Screen
  user: SelfUser | null
  target: Target | null
  connection: ConnectionStatus | null
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
  setLoggingIn(v: boolean): void
  pushToast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
}

let toastId = 0

export const useStore = create<State & Actions>((set) => ({
  screen: 'splash',
  user: null,
  target: null,
  connection: null,
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
  appendLog: (entries) =>
    set((s) => {
      const merged = s.log.concat(entries)
      return { log: merged.length > MAX_LOG ? merged.slice(merged.length - MAX_LOG) : merged }
    }),
  setUser: (user) => set({ user }),
  setTarget: (target) => set({ target }),
  setLoggingIn: (loggingIn) => set({ loggingIn }),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: ++toastId }].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

function routeFor(user: SelfUser | null, target: Target | null): Screen {
  return user && target ? 'dashboard' : user ? 'picker' : 'onboarding'
}

/** Subscribes the store to main-process events and resolves the first screen. Call once from <App />. */
export function useApiEvents(): void {
  useEffect(() => {
    const api = window.api
    const st = useStore
    let cancelled = false

    /** Reads the auth state and routes, unless the user is mid-way through onboarding. */
    const resolveFirstScreen = async (): Promise<void> => {
      try {
        const { user, target } = await api.auth.status()
        if (cancelled) return
        const s = st.getState()
        s.setUser(user)
        s.setTarget(target)
        if (s.connection === 'invalidToken') return
        if (!user && s.connection === 'connecting') return // auto-login in progress: keep the splash
        if (s.screen === 'splash' || (s.screen === 'onboarding' && !s.loggingIn && user)) {
          s.goto(routeFor(user, target))
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
      api.on('game.patch', (p) => st.getState().applyPatch(p)),
      api.on('log.append', (e) => st.getState().appendLog(e)),
      api.on('captcha.show', (c) => st.setState({ captcha: { imageUrl: c.imageUrl, text: c.text } })),
      api.on('captcha.hide', () => st.setState({ captcha: null })),
      api.on('toast', (t) => st.getState().pushToast(t)),
      api.on('connection.status', ({ status }) => {
        st.setState({ connection: status })
        if (status === 'invalidToken') {
          st.setState({ authError: 'Token invalide ou expiré', user: null, screen: 'onboarding' })
        } else if (status === 'disconnected' && st.getState().screen === 'splash') {
          void resolveFirstScreen()
        } else if (status === 'connected') {
          st.setState({ authError: null })
          void resolveFirstScreen()
        }
      })
    ]

    api.config
      .get()
      .then((config) => !cancelled && st.setState({ config }))
      .catch(() => undefined)
    void resolveFirstScreen()

    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [])
}
