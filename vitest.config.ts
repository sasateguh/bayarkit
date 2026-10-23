import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Every packages/<name> resolves to its source, so tests never depend on a stale build. New packages need no edit here.
const packages = fileURLToPath(new URL('./packages/', import.meta.url))
const alias = Object.fromEntries(
  readdirSync(packages).map((name) => [`@bayarkit/${name}`, `${packages}${name}/src/index.ts`]),
)

export default defineConfig({
  resolve: { alias },
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 15_000 },
})
