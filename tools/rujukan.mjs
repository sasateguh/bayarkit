#!/usr/bin/env node
/**
 * rujukan — keep bayarkit aware of every gateway's official documentation.
 *
 *   node tools/rujukan.mjs check [--update] [--only <id>]   fetch every official source, compare with sources.lock.json
 *   node tools/rujukan.mjs lint                            offline: registry ↔ adapters ↔ specs ↔ generated skills agree
 *   node tools/rujukan.mjs skills [--check]                generate skills/<id>/SKILL.md, README tables and every
 *                                                          package's package.json metadata + README (tools/pakej.mjs)
 *
 * The public repo stores only fingerprints (sha256 of the normalised text) and dates: third-party documentation is
 * copyrighted, so full snapshots and diffs go to a private directory (RUJUKAN_SNAPSHOTS, default
 * ~/.local/state/bayarkit/rujukan). `check` exits 2 when any source changed, so cron can raise an alert; the adapter and
 * fake for that gateway are then re-read against the new docs (fake first, as always).
 *
 * Zero dependencies (Node ≥ 22). Measured 23 Oct 2026: two fetches a few seconds apart give identical fingerprints for
 * the toyyibPay, Bayarcash SDK, Billplz and Stripe sources, so a change is a change, not page noise.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageFiles } from './pakej.mjs'
import { fillSupport, loadSupport, SUPPORT_READMES, supportSection } from './support.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = join(ROOT, 'gateways', 'registry.json')
const LOCK = join(ROOT, 'gateways', 'sources.lock.json')
const SNAPSHOTS = process.env.RUJUKAN_SNAPSHOTS || join(homedir(), '.local', 'state', 'bayarkit', 'rujukan')

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
const today = () => new Date().toISOString().slice(0, 10)

/**
 * HTML → visible text; plain text (SDK source, Markdown) is only whitespace-collapsed. With `url`, links to the page's
 * own site are made relative (`](https://curlec.com/docs/…` → `](/docs/…`): docs sites flip between the two, and that
 * alone once raised five "changed" alerts in one night with identical text (Curlec, HitPay, 23 Oct 2026).
 */
export function normalise(body, contentType = '', url = '') {
  let s = body
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(s)) {
    s = s
      .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  }
  if (url) {
    const origin = new URL(url).origin
    // Plain split/join, no regex built from data.
    for (const prefix of ['](', 'href="', "href='"]) s = s.split(`${prefix}${origin}/`).join(`${prefix}/`)
  }
  return s.replace(/\s+/g, ' ').trim()
}

const fingerprint = (text) => createHash('sha256').update(text).digest('hex')

async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: { 'user-agent': 'bayarkit-rujukan (+https://github.com/sasateguh/bayarkit)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // No per-source ignore patterns: none was needed (12/12 sources stable), and regexes from data invite ReDoS.
  const text = normalise(await res.text(), res.headers.get('content-type') ?? '', source.url)
  if (text.length < 200) throw new Error(`only ${text.length} characters of text (JavaScript-rendered page?)`)
  // A shell page (JavaScript-rendered docs, a login wall, a GitBook landing page) can be long and still say nothing.
  const missing = (source.mustContain ?? []).filter((w) => !text.includes(w))
  if (missing.length)
    throw new Error(`text lacks ${missing.map((w) => `"${w}"`).join(', ')} (not the real documentation?)`)
  return text
}

async function check(args) {
  const registry = readJson(REGISTRY)
  const lock = readJson(LOCK, {})
  // Private state, never in the repo: when each source was last checked, and which changes were already reported.
  mkdirSync(SNAPSHOTS, { recursive: true })
  const statePath = join(SNAPSHOTS, 'state.json')
  const state = readJson(statePath, { checked: {}, reported: {} })
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
  const update = args.includes('--update')
  const fresh = []
  const pending = []
  const failed = []
  for (const gw of registry.gateways) {
    if (only && gw.id !== only) continue
    for (const source of gw.sources ?? []) {
      const key = `${gw.id}/${source.id}`
      let text
      try {
        text = await fetchSource(source)
      } catch (e) {
        failed.push(`${key}: ${e.message}`)
        continue
      }
      const hash = fingerprint(text)
      const before = lock[key]
      const dir = join(SNAPSHOTS, gw.id)
      mkdirSync(dir, { recursive: true })
      const latest = join(dir, `${source.id}.txt`)
      if (!before || update) {
        if (!before || before.sha256 !== hash) {
          lock[key] = { url: source.url, sha256: hash, chars: text.length, since: today() }
          console.log(`${before ? '✓ accepted' : '+ new'} ${key} (${source.url})`)
        }
        delete state.reported[key]
      } else if (before.sha256 !== hash) {
        // Keep the text the lock describes next to the new one, privately, so a human can read what changed.
        const was = join(dir, `${source.id}.${before.sha256.slice(0, 12)}.txt`)
        if (existsSync(latest) && !existsSync(was)) writeFileSync(was, readFileSync(latest))
        const line = `${key} (${source.url}): compare ${was} with ${latest}`
        if (state.reported[key] === hash) pending.push(line)
        else {
          fresh.push(line)
          state.reported[key] = hash
        }
      }
      // While a change is unreviewed, `latest` keeps the newest text and `was` keeps the reviewed one.
      writeFileSync(latest, text)
      state.checked[key] = today()
    }
  }
  writeJson(LOCK, Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))))
  writeJson(statePath, state)
  for (const line of fresh) console.log(`△ CHANGED ${line}`)
  for (const line of pending) console.log(`… still unreviewed ${line}`)
  for (const line of failed) console.log(`✗ ${line}`)
  console.log(`${fresh.length} newly changed, ${pending.length} awaiting review, ${failed.length} failed`)
  if (fresh.length || pending.length) {
    console.log(
      'Review: re-read the spec, fake and adapter against the new docs, then `check --update --only <id>`.',
    )
  }
  if (failed.length) return 3
  return fresh.length ? 2 : 0
}

/** Offline consistency: the gate runs this. */
function lint() {
  const registry = readJson(REGISTRY)
  const lock = readJson(LOCK, {})
  const problems = []
  const ids = new Set()
  for (const gw of registry.gateways) {
    if (!/^[a-z0-9-]+$/.test(gw.id)) problems.push(`${gw.id}: id must be lowercase letters, digits, dashes`)
    if (ids.has(gw.id)) problems.push(`${gw.id}: duplicate id`)
    ids.add(gw.id)
    if (!/^https:\/\//.test(gw.site ?? '')) problems.push(`${gw.id}: site must be an https URL`)
    for (const s of gw.sources ?? []) {
      if (!/^https:\/\//.test(s.url)) problems.push(`${gw.id}/${s.id}: source must be an https URL`)
      if (!lock[`${gw.id}/${s.id}`]) problems.push(`${gw.id}/${s.id}: no fingerprint yet (run check)`)
      if (!s.mustContain?.length)
        problems.push(`${gw.id}/${s.id}: mustContain is empty (shell pages would pass)`)
    }
    for (const g of gw.gotchas ?? []) {
      if (!g.text || !g.text_ms || !g.source)
        problems.push(`${gw.id}: every gotcha needs text, text_ms (Bahasa Melayu) and a source`)
    }
    if (gw.adapter) {
      const pkgDir = join(ROOT, 'packages', gw.id)
      if (!existsSync(join(pkgDir, 'src', 'index.ts')))
        problems.push(`${gw.id}: adapter listed but packages/${gw.id} missing`)
      else {
        const src = readFileSync(join(pkgDir, 'src', 'index.ts'), 'utf8')
        const kind = /evidence:\s*\{\s*kind:\s*'(measured|docs)'/.exec(src)?.[1]
        for (const [path, what] of [
          [join(ROOT, 'packages', 'testing', 'src', 'cli', `${gw.id}.ts`), 'bayarkit-fake entry'],
          [join(ROOT, 'scripts', 'smoke', `${gw.id}.mjs`), 'packed smoke setup'],
        ]) {
          if (!existsSync(path)) problems.push(`${gw.id}: ${what} missing (${path.slice(ROOT.length + 1)})`)
        }
        if (kind !== gw.adapter.evidence) {
          problems.push(`${gw.id}: registry says evidence "${gw.adapter.evidence}", adapter says "${kind}"`)
        }
      }
    }
    if (gw.spec) {
      const specPath = join(ROOT, 'gateways', gw.id, 'spec.md')
      if (!existsSync(specPath)) problems.push(`${gw.id}: spec listed but gateways/${gw.id}/spec.md missing`)
      else if (!(gw.sources ?? []).length)
        problems.push(`${gw.id}: a spec needs at least one official source`)
    }
  }
  const pkgs = readdirSync(join(ROOT, 'packages')).filter((p) => !['core', 'testing'].includes(p))
  for (const p of pkgs) {
    if (!registry.gateways.some((g) => g.id === p && g.adapter))
      problems.push(`packages/${p}: adapter missing from registry`)
  }
  for (const p of problems) console.log(`✗ ${p}`)
  console.log(
    problems.length ? `${problems.length} problem(s)` : `registry ok: ${registry.gateways.length} gateways`,
  )
  return problems.length ? 1 : 0
}

function skillFor(gw, lock) {
  const name = gw.name
  // Adapters that cannot charge ringgit (Paddle) or default to another currency (PayPal) say so in the registry.
  const currency = gw.adapter?.currency ?? 'MYR'
  const myr = currency === 'MYR'
  const sources = (gw.sources ?? [])
    .map((s) => {
      const l = lock[`${gw.id}/${s.id}`]
      // Only `since` (changes when the docs change); a daily "last checked" date would make every generated file stale.
      return `- [${s.title ?? s.id}](${s.url})${l ? ` (fingerprint \`${l.sha256.slice(0, 12)}\`, unchanged since ${l.since})` : ''}`
    })
    .join('\n')
  const adapter = gw.adapter
    ? `## Use the bayarkit adapter

Install \`@bayarkit/core\` and \`${gw.adapter.package}\`. Evidence: **${gw.adapter.evidence === 'measured' ? `measured on the ${name} sandbox` : 'written from the official docs, not yet measured on the sandbox'}**.

\`\`\`ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { ${gw.adapter.factory} } from '${gw.adapter.package}'

const gateway = ${gw.adapter.factory}(${gw.adapter.configExample})
const payment = await gateway.createPayment({ reference, amount /* ${myr ? 'sen' : `${currency} smallest unit`} */, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting page when the gateway wants a POST form
${gw.adapter.flow?.code ? `${gw.adapter.flow.code}\n` : ''}// then, in the callback route:
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount${myr ? '' : `, currency: '${currency}'`} })
\`\`\`
${gw.adapter.flow ? `\n${gw.adapter.flow.en}\n` : ''}
Test without real money: \`${gw.adapter.fake}\` from \`@bayarkit/testing\`.`
    : `## No bayarkit adapter yet

Implement it with the official sources below, then follow the rules in this skill. To contribute an adapter, see
CONTRIBUTING.md in https://github.com/sasateguh/bayarkit.`
  const spec = gw.spec
    ? `\nThe full contract with a source for every fact: \`gateways/${gw.id}/spec.md\` in the bayarkit repository.\n`
    : ''
  const gotchas = (gw.gotchas ?? []).length
    ? `\n## ${name} traps (each from an official source or a sandbox measurement)\n\n${gw.gotchas.map((g) => `- ${g.text} *(${g.source})*`).join('\n')}\n`
    : ''
  return `---
name: bayarkit-${gw.id}
description: Integrate ${name} payments (${myr ? 'Malaysia' : 'from Malaysia'}) safely. Use when adding ${name} checkout, callbacks or payment status checks to an app.
---

# ${name}

${adapter}
${spec}${gotchas}
## Rules that apply to every ${myr ? 'Malaysian gateway' : 'gateway'}

1. ${myr ? 'Amounts are integer sen. Never compare floating-point ringgit.' : "Amounts are integers in the currency's smallest unit (cents). Never compare floating-point amounts."}
2. Never mark an order paid from the return URL or the callback body alone: verify the signature, ask the gateway again,
   then match reference, amount and currency exactly (\`confirmPayment\` does all three).
3. Gateways retry callbacks: marking an order paid must be idempotent.
4. Use one reference per payment attempt, so a late callback from an old attempt cannot match a new one.
5. Errors and logs never contain keys or secrets.

## Official sources

${sources || '- (none recorded yet)'}

Generated by \`node tools/rujukan.mjs skills\` from \`gateways/registry.json\`. Do not edit by hand.
`
}

function coverage(registry, lock) {
  const rows = registry.gateways.map((gw) => {
    const since = (gw.sources ?? [])
      .map((s) => lock[`${gw.id}/${s.id}`]?.since)
      .filter(Boolean)
      .sort()
      .at(-1)
    const adapter = gw.adapter ? `\`${gw.adapter.package}\` (${gw.adapter.evidence})` : '—'
    const spec = gw.spec ? `[spec](${gw.id}/spec.md)` : '—'
    const traps = (gw.gotchas ?? []).length
    return `| [${gw.name}](${gw.site}) | ${adapter} | ${spec} | ${(gw.sources ?? []).length} | ${traps} | ${since ?? '—'} |`
  })
  return `# Gateway coverage

Generated by \`node tools/rujukan.mjs skills\` from \`registry.json\`. Do not edit by hand.

- **adapter**: a runnable \`@bayarkit/*\` package; *measured* = run against the gateway's sandbox, *docs* = written from
  official documentation only.
- **spec**: the API contract with an official source next to every fact.
- **sources**: official documentation and official SDK code that \`rujukan check\` fingerprints; a change raises an alert so
  the spec, the fake and the adapter are re-read against the new docs.

| Gateway | Adapter | Spec | Sources watched | Traps recorded | Docs unchanged since |
|---|---|---|---|---|---|
${rows.join('\n')}
`
}

/** A Markdown table aligned the way Biome formats it, so the formatter leaves generated tables alone. */
function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

const README_LANG = {
  'README.md': {
    lang: 'en',
    header: ['Gateway', 'Package', 'Evidence'],
    count: [
      /(\*\*Status:\*\* [0-9.]+\. )[A-Za-z]+( gateways)/,
      [
        'Zero',
        'One',
        'Two',
        'Three',
        'Four',
        'Five',
        'Six',
        'Seven',
        'Eight',
        'Nine',
        'Ten',
        'Eleven',
        'Twelve',
        'Thirteen',
        'Fourteen',
        'Fifteen',
        'Sixteen',
      ],
    ],
  },
  'README.ms.md': {
    lang: 'ms',
    header: ['Gateway', 'Pakej', 'Bukti'],
    count: [
      /(\*\*Status:\*\* [0-9.]+\. )[A-Za-z ]+?( gateway dalam)/,
      [
        'Sifar',
        'Satu',
        'Dua',
        'Tiga',
        'Empat',
        'Lima',
        'Enam',
        'Tujuh',
        'Lapan',
        'Sembilan',
        'Sepuluh',
        'Sebelas',
        'Dua belas',
        'Tiga belas',
        'Empat belas',
        'Lima belas',
        'Enam belas',
      ],
    ],
  },
}

/** README gateway tables + the gateway count in the status line, both from the registry. */
function readmes(registry) {
  const adapters = registry.gateways.filter((g) => g.adapter)
  return Object.entries(README_LANG).map(([file, cfg]) => {
    const path = join(ROOT, file)
    const text = readFileSync(path, 'utf8')
    const rows = adapters.map((g) => {
      const label = g.adapter.label?.[cfg.lang]
      const summary = g.adapter.summary?.[cfg.lang]
      if (!label || !summary)
        throw new Error(`${g.id}: adapter.label.${cfg.lang} and adapter.summary.${cfg.lang} are required`)
      return [label, `\`${g.adapter.package}\``, summary]
    })
    const start = '<!-- gateways:table'
    const end = '<!-- /gateways:table -->'
    const a = text.indexOf(start)
    const b = text.indexOf(end)
    if (a < 0 || b < a) throw new Error(`${file}: gateways:table markers missing`)
    const open = text.slice(a, text.indexOf('\n', a) + 1)
    let out = `${text.slice(0, a)}${open}${table(cfg.header, rows)}\n${text.slice(b)}`
    const [pattern, words] = cfg.count
    if (!pattern.test(out)) throw new Error(`${file}: status line with the gateway count not found`)
    out = out.replace(pattern, `$1${words[adapters.length] ?? adapters.length}$2`)
    return [path, out]
  })
}

/** The "need help installing?" block in the repository and PHP READMEs, from docs/support.json. */
function supportReadmes(pending) {
  const config = loadSupport(ROOT)
  return Object.entries(SUPPORT_READMES).map(([file, lang]) => {
    const path = join(ROOT, file)
    const text = pending.get(path) ?? readFileSync(path, 'utf8')
    return [path, fillSupport(text, supportSection(config, lang), file)]
  })
}

function skills(args) {
  const registry = readJson(REGISTRY)
  const lock = readJson(LOCK, {})
  const stale = []
  const files = [
    [join(ROOT, 'gateways', 'README.md'), coverage(registry, lock)],
    ...readmes(registry),
    // npm's view of every package (metadata + README), from the root package.json and the registry.
    ...packageFiles(ROOT, registry),
  ]
  // README.md and README.ms.md also carry the gateway table: fill the support block on top of that text.
  const pending = new Map(files)
  for (const [path, text] of supportReadmes(pending)) {
    if (pending.has(path)) files[files.findIndex(([p]) => p === path)][1] = text
    else files.push([path, text])
  }
  for (const gw of registry.gateways) {
    // A skill without official sources would be guesswork; inventory-only gateways get none yet.
    if (!(gw.sources ?? []).length) continue
    files.push([join(ROOT, 'skills', gw.id, 'SKILL.md'), skillFor(gw, lock)])
  }
  for (const [path, text] of files) {
    if (args.includes('--check')) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) stale.push(path)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  if (stale.length) {
    for (const p of stale) console.log(`✗ out of date: ${p} (run node tools/rujukan.mjs skills)`)
    return 1
  }
  console.log(args.includes('--check') ? 'skills up to date' : `wrote ${files.length} files`)
  return 0
}

// Run only as a CLI, so tests (and the re-baseline check) can import `normalise`. Real paths on both sides: through a
// symlink the comparison once failed and the CLI exited 0 having checked nothing.
const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : ''
if (invoked && realpathSync(fileURLToPath(import.meta.url)) === invoked) {
  const [command, ...args] = process.argv.slice(2)
  const commands = { check, lint, skills }
  if (!commands[command]) {
    console.log('usage: node tools/rujukan.mjs check [--update] [--only id] | lint | skills [--check]')
    process.exit(64)
  }
  process.exitCode = await commands[command](args)
}
