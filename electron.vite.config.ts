import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// The strict production CSP blocks the react-refresh inline preamble and the HMR websocket,
// so in dev only (`vite serve`) allow what Vite needs.
const devCsp: Plugin = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws:; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net data:" />`
    )
  }
}

const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react(), devCsp],
    resolve: { alias }
  }
})
