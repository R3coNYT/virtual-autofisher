import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The strict production CSP blocks the react-refresh inline preamble and the HMR websocket,
// so in dev only (`vite serve`) allow what Vite needs.
const devCsp: Plugin = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost ws:; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net data:" />`
    )
  }
}

// Renderer only: the backend is the Rust/Tauri crate in src-tauri/.
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react(), devCsp],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: resolve('out/renderer'), emptyOutDir: true, target: 'es2022' }
})
