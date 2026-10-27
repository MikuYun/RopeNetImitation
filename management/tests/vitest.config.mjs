import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const frontend = resolve(fileURLToPath(new URL('.', import.meta.url)), '../frontend')

export default defineConfig({
  root: frontend,
  resolve: { alias: { '@': resolve(frontend, 'src') } },
  test: {
    environment: 'node',
    include: ['../pm-tests/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
