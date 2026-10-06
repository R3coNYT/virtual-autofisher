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
  opts: { start: () => Promise<void>; onError: (e: unknown) => void; quit: () => void }
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
    switch (state) {
      case 'running':
      case 'resting':
        return { label: 'Pause', enabled: true, click: () => engine.pause() }
      case 'paused':
        return { label: 'Resume', enabled: true, click: () => engine.resume() }
      case 'stopping': // shown like running, nothing to toggle while the stop completes
        return { label: 'Pause', enabled: false, click: () => undefined }
      case 'idle':
      case 'error':
        // the target is read when clicked (opts.start), so a channel picked later is honoured
        return { label: 'Start', enabled: true, click: () => void opts.start().catch(opts.onError) }
      default: // connecting, captcha: nothing to toggle
        return { label: 'Start', enabled: false, click: () => undefined }
    }
  }

  /** Graceful stop; while already stopping it forces the immediate halt. */
  const stopItem = (state: EngineState): { label: string; enabled: boolean; click: () => void } => {
    switch (state) {
      case 'running':
      case 'resting':
      case 'paused':
        return { label: 'Stop', enabled: true, click: () => engine.stop({ graceful: true }) }
      case 'stopping':
        return { label: 'Force stop', enabled: true, click: () => engine.stop() }
      default: // idle, error, connecting, captcha (the captcha panel has its own stop)
        return { label: 'Stop', enabled: false, click: () => undefined }
    }
  }

  const refresh = (state: EngineState): void => {
    if (tray.isDestroyed()) return
    tray.setImage(state === 'captcha' ? alert : normal)
    tray.setToolTip(
      state === 'captcha'
        ? 'Virtual AutoFisher — captcha to solve'
        : state === 'stopping'
          ? 'Virtual AutoFisher — stopping'
          : 'Virtual AutoFisher'
    )
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show', click: showWindow },
        { ...toggle(state) },
        { ...stopItem(state) },
        { type: 'separator' },
        { label: 'Quit', click: opts.quit }
      ])
    )
  }

  refresh(engine.state)
  engine.onState((s) => refresh(s))
  tray.on('click', showWindow)
  return tray
}
