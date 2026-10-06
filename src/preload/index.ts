import { contextBridge, ipcRenderer } from 'electron'
import type { Api, EventChannel } from '../shared/ipc'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  auth: {
    setToken: (token) => invoke('auth.setToken', token),
    logout: () => invoke('auth.logout'),
    status: () => invoke('auth.status')
  },
  guilds: { list: () => invoke('guilds.list') },
  channels: { list: (guildId) => invoke('channels.list', guildId) },
  target: { set: (guildId, channelId) => invoke('target.set', guildId, channelId) },
  engine: {
    start: () => invoke('engine.start'),
    pause: () => invoke('engine.pause'),
    resume: () => invoke('engine.resume'),
    stop: (graceful) => invoke('engine.stop', graceful),
    commands: () => invoke('engine.commands'),
    status: () => invoke('engine.status')
  },
  command: { send: (name, options) => invoke('command.send', name, options) },
  captcha: {
    submit: (answer) => invoke('captcha.submit', answer),
    regen: () => invoke('captcha.regen')
  },
  config: {
    get: () => invoke('config.get'),
    update: (patch) => invoke('config.update', patch)
  },
  app: { openDataDir: () => invoke('app.openDataDir') },
  on: (channel: EventChannel, cb) => {
    const listener = (_e: unknown, payload: unknown): void => (cb as (p: unknown) => void)(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
