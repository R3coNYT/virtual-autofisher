import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { ConfigStore } from './config/ConfigStore'
import { safeStorageCipher } from './config/safeStorageCipher'
import { SelfbotClient } from './discord/SelfbotClient'
import { Engine } from './engine/Engine'
import { GameState } from './engine/GameState'
import { registerHandlers } from './ipc/handlers'
import { createLogger } from './util/logger'

const logger = createLogger(join(app.getPath('userData'), 'logs'))
process.on('uncaughtException', (e) => logger.error('uncaughtException', e))
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e))

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a1628',
    title: 'Virtual AutoFisher',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function boot(): void {
  const userData = app.getPath('userData')
  const config = new ConfigStore(userData, safeStorageCipher, logger)
  config.load()
  const client = new SelfbotClient({ logger })
  const state = new GameState()
  const engine = new Engine({ client, config, state, logger })

  let win = createWindow()
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const { autoLogin } = registerHandlers({
    ipc: ipcMain,
    config,
    client,
    engine,
    state,
    send,
    sessionsDir: join(userData, 'sessions'),
    dataDir: userData,
    openPath: (p) => shell.openPath(p),
    setCaptureDir: (dir) => client.setCaptureDir(dir),
    captureDir: join(userData, 'captures'),
    logger
  })
  // log in once the renderer is listening, so it receives connection.status
  win.webContents.once('did-finish-load', () => void autoLogin())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })
}

app.whenReady().then(boot).catch((e) => logger.error('boot failed', e))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
