import { BrowserWindow, Notification, shell } from 'electron'
import type { Config } from '../shared/types'

function reveal(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Blinks the taskbar button until the window regains focus. */
function flashUntilFocused(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isFocused()) return
  win.flashFrame(true)
  win.once('focus', () => {
    if (!win.isDestroyed()) win.flashFrame(false)
  })
}

function show(win: BrowserWindow, title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => reveal(win))
  n.show()
}

/** Clickable Windows notification (brings the window forward), optional beep, taskbar flash. */
export function notifyCaptcha(win: BrowserWindow, cfg: Config['notifications']): void {
  if (!cfg.captcha) return
  show(win, 'Captcha Virtual Fisher', 'Résous le captcha pour reprendre la pêche.')
  if (cfg.sound) shell.beep()
  flashUntilFocused(win)
}

export function notifyLevelUp(win: BrowserWindow, cfg: Config['notifications'], level: number): void {
  if (cfg.levelUp) show(win, 'Niveau supérieur !', `Vous avez atteint le niveau ${level}.`)
}

export function notifyRareFish(win: BrowserWindow, cfg: Config['notifications'], kinds: string[]): void {
  if (cfg.rareFish && kinds.length) show(win, 'Poisson rare !', `Vous avez pêché : ${kinds.join(', ')}.`)
}
