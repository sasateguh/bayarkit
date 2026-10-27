#!/usr/bin/env node
// Release invariants, checked in the gate (no argument) and again by the release workflow (with the tag).
// All packages move in lockstep: one version, and every @bayarkit/* dependency pins exactly that version, so a user
// never mixes a core and an adapter from different releases. Packagist takes the PHP version from the git tag, so
// php/composer.json must not carry a "version" field that could disagree with it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const tag = process.argv[2]
const errors = []
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))

const pkgs = readdirSync(join(root, 'packages')).map((d) => ({
  dir: d,
  json: read(`packages/${d}/package.json`),
}))
const versions = new Set(pkgs.map((p) => p.json.version))
if (versions.size !== 1) errors.push(`packages are not on one version: ${[...versions].join(', ')}`)
const version = pkgs.find((p) => p.dir === 'core')?.json.version

for (const { dir, json } of pkgs) {
  if (json.private) errors.push(`packages/${dir} is private`)
  if (json.publishConfig?.access !== 'public')
    errors.push(`packages/${dir}: publishConfig.access is not "public"`)
  if (json.publishConfig?.provenance !== true)
    errors.push(`packages/${dir}: publishConfig.provenance is not true`)
  for (const [name, range] of Object.entries(json.dependencies ?? {})) {
    if (name.startsWith('@bayarkit/') && range !== version)
      errors.push(`packages/${dir}: ${name} is "${range}", not "${version}"`)
  }
}

if ('version' in read('php/composer.json'))
  errors.push('php/composer.json has a "version" field (Packagist reads the tag)')
if (tag !== undefined && tag !== `v${version}`)
  errors.push(`tag ${tag} does not match the package version v${version}`)

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.log(`✓ release check: ${pkgs.length} packages at ${version}${tag ? `, tag ${tag}` : ''}`)
