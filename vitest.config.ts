import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@bayarkit/core': src('core'),
      '@bayarkit/testing': src('testing'),
      '@bayarkit/toyyibpay': src('toyyibpay'),
      '@bayarkit/bayarcash': src('bayarcash'),
      '@bayarkit/billplz': src('billplz'),
      '@bayarkit/stripe': src('stripe'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 15_000 },
})
