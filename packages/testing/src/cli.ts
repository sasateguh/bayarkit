#!/usr/bin/env node
/**
 * bayarkit-fake — run one fake gateway as a standalone server, for tests in any language.
 *
 *   npx bayarkit-fake <gateway> [--control-port N] [--<option> <value> ...]
 *
 * Prints ONE JSON line ({ gateway, url, control, options }) and serves until SIGINT/SIGTERM. Options are the fake's
 * own (e.g. --secretKey, --webhookSecret); test defaults are used for the rest and echoed in `options`.
 * Each gateway is one file in ./cli/ (loaded on demand), so adding a gateway never edits this file, and vitest is not
 * needed (the package index, which pulls in the conformance suite, is not imported).
 */
import { readdirSync } from 'node:fs'
import type { CliFake } from './cli/types.js'
import { startControlServer } from './control.js'

const dir = new URL('./cli/', import.meta.url)
const available = readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== 'types.js')
  .map((f) => f.slice(0, -3))
  .sort()

const [gateway, ...rest] = process.argv.slice(2)
// Only names that exist in ./cli/ are imported, so the argument can never reach another path.
if (!gateway || !available.includes(gateway)) {
  console.error(`usage: bayarkit-fake <${available.join('|')}> [--control-port N] [--<option> <value> ...]`)
  process.exit(64)
}
const entry = ((await import(new URL(`${gateway}.js`, dir).href)) as { default: CliFake }).default
const options: Record<string, string> = { ...entry.defaults }
let controlPort = 0
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '') ?? ''
  const value = rest[i + 1] ?? ''
  if (key === 'control-port') controlPort = Number(value)
  else options[key] = value
}
const fake = await entry.start(options)
const control = await startControlServer(gateway, fake, controlPort)
console.log(JSON.stringify({ gateway, url: fake.url, control: control.url, options }))
const stop = async () => {
  await control.close()
  await fake.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
