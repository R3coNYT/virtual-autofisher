import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import type { EngineState } from '../shared/types'
import type { Engine } from './engine/Engine'

/** Runtime icon files: <repo>/resources in dev, <install>/resources (extraResources) when packaged. */
export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
}

const trayImage = (name: string): Electron.NativeImage => nativeImage.createFromPath(resourcePath(name)).resize({ width: 32, height: 32 })

export function createTray(
  win: BrowserWindow,
  engine: Engine,
  opts: { getTarget: () => { guildId: string; channelId: string } | null; quit: () => void }
): Tray {
  const normal = trayImage('icon.png')
  const alert = trayImage('icon-alert.png')
  const tray = new Tray(normal)

  const showWindow = (): void => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const toggle = (state: EngineState): { label: string; enabled: boolean; click: () => void } => {
    const run = (p: Promise<void> | void): void => void Promise.resolve(p).catch(() => undefined)
    switch (state) {
      case 'running':
      case 'resting':
        return { label: 'Pause', enabled: true, click: () => engine.pause() }
      case 'paused':
        return { label: 'Reprendre', enabled: true, click: () => engine.resume() }
      case 'idle':
      case 'error': {
        const target = opts.getTarget()
        return { label: 'Démarrer', enabled: target !== null, click: () => target && run(engine.start(target)) }
      }
      default: // connecting, captcha: nothing to toggle
        return { label: 'Démarrer', enabled: false, click: () => undefined }
    }
  }

  const refresh = (state: EngineState): void => {
    tray.setImage(state === 'captcha' ? alert : normal)
    tray.setToolTip(state === 'captcha' ? 'Virtual AutoFisher — captcha à résoudre' : 'Virtual AutoFisher')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Afficher', click: showWindow },
        { ...toggle(state) },
        { type: 'separator' },
        { label: 'Quitter', click: opts.quit }
      ])
    )
  }

  refresh(engine.state)
  engine.onState((s) => refresh(s))
  tray.on('click', showWindow)
  return tray
}
