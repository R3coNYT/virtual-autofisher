import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // fake-timer tests simulate hours of fishing: leave headroom for slower CI runners
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15_000 }
})
