import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Api, EventChannel } from '../shared/ipc'

/** Tauri event names cannot contain dots: the backend emits `engine:state` for `engine.state`. */
export const tauriEventName = (channel: EventChannel): string => channel.replace('.', ':')

/** `window.api` over Tauri: each method invokes the backend command of the same name (snake_case). */
export function createTauriApi(): Api {
  return {
    auth: {
      setToken: (token) => invoke('auth_set_token', { token }),
      logout: () => invoke('auth_logout'),
      status: () => invoke('auth_status')
    },
    guilds: { list: (opts) => invoke('guilds_list', { refresh: opts?.refresh === true }) },
    channels: { list: (guildId) => invoke('channels_list', { guildId }) },
    target: { set: (guildId, channelId) => invoke('target_set', { guildId, channelId }) },
    engine: {
      start: () => invoke('engine_start'),
      pause: () => invoke('engine_pause'),
      resume: () => invoke('engine_resume'),
      stop: (graceful) => invoke('engine_stop', { graceful: graceful ?? null }),
      commands: () => invoke('engine_commands'),
      status: () => invoke('engine_status')
    },
    command: { send: (name, options) => invoke('command_send', { name, options: options ?? null }) },
    captcha: {
      submit: (answer) => invoke('captcha_submit', { answer }),
      regen: () => invoke('captcha_regen')
    },
    config: {
      get: () => invoke('config_get'),
      update: (patch) => invoke('config_update', { patch })
    },
    app: { openDataDir: () => invoke('app_open_data_dir') },
    on: (channel, cb) => {
      // listen() resolves asynchronously: the returned unsubscribe works even before it does
      let unlisten: UnlistenFn | null = null
      let done = false
      void listen(tauriEventName(channel), (e) => (cb as (p: unknown) => void)(e.payload ?? undefined)).then((u) => {
        if (done) u()
        else unlisten = u
      })
      return () => {
        done = true
        unlisten?.()
      }
    }
  }
}

export function installTauriApi(): void {
  window.api = createTauriApi()
}
