/**
 * What npm shows for each package — package.json metadata and README.md — generated, so 16 packages never drift:
 * project facts (repository, homepage, author, base keywords) come from the root package.json, gateway facts (label,
 * evidence summary, factory, config, fake, gotchas) from gateways/registry.json. `rujukan skills --check` fails when a
 * generated file is out of date. Hand-written per package: `description`, dependencies, exports.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Keys first in this order; everything else keeps its place after them. */
const ORDER = [
  'name',
  'version',
  'description',
  'keywords',
  'homepage',
  'bugs',
  'repository',
  'license',
  'author',
  'type',
  'sideEffects',
  'exports',
  'files',
  'engines',
  'publishConfig',
]

const repoUrl = (root) => root.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

function metadata(dir, pkg, root, extraKeywords) {
  const out = {
    ...pkg,
    keywords: [...new Set([...root.keywords, ...extraKeywords])],
    homepage: `${repoUrl(root)}/tree/main/packages/${dir}#readme`,
    bugs: root.bugs,
    repository: { ...root.repository, directory: `packages/${dir}` },
    license: root.license,
    author: root.author,
    sideEffects: false,
    // Trusted publishing from the public repository signs every release (provenance); D7.
    publishConfig: { access: 'public', provenance: true },
  }
  const ordered = Object.fromEntries(ORDER.filter((k) => k in out).map((k) => [k, out[k]]))
  for (const [k, v] of Object.entries(out)) if (!(k in ordered)) ordered[k] = v
  return `${JSON.stringify(ordered, null, 2)}\n`
}

const usage = (gw) => `\`\`\`ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { ${gw.adapter.factory} } from '${gw.adapter.package}'

const gateway = ${gw.adapter.factory}(${gw.adapter.configExample})

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
\`\`\``

function adapterReadme(gw, root) {
  const repo = repoUrl(root)
  const label = (lang) => gw.adapter.label[lang]
  const summary = (lang) => gw.adapter.summary[lang]
  const gotchas = (gw.gotchas ?? []).map((g) => `- ${g.text} (${g.source})`).join('\n')
  const spec = `${repo}/blob/main/gateways/${gw.id}/spec.md`
  return `# ${gw.adapter.package}

${label('en')} for [bayarkit](${repo}): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** ${summary('en')}.

\`\`\`bash
npm install @bayarkit/core ${gw.adapter.package}
\`\`\`

${usage(gw)}

Test without real money: \`${gw.adapter.fake}\` from \`@bayarkit/testing\` answers like this gateway (signed callbacks
included), and \`npx bayarkit-fake ${gw.id}\` runs it as a server for tests in other languages.

${gotchas ? `## Traps\n\n${gotchas}\n\n` : ''}The full contract, with a source for every fact: [gateways/${gw.id}/spec.md](${spec}).

## Bahasa Melayu

${label('ms')} untuk [bayarkit](${repo}): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** ${summary('ms')}.

\`\`\`bash
npm install @bayarkit/core ${gw.adapter.package}
\`\`\`

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
\`confirmPayment\` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: \`${gw.adapter.fake}\` daripada \`@bayarkit/testing\`, atau \`npx bayarkit-fake ${gw.id}\` sebagai
pelayan. ${gotchas ? 'Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. ' : ''}Kontrak penuh:
[gateways/${gw.id}/spec.md](${spec}). Dokumentasi penuh: [README.ms.md](${repo}/blob/main/README.ms.md).

MIT © ${root.author.replace(/\s*\(.*\)$/, '')}
`
}

function coreReadme(root, adapters) {
  const repo = repoUrl(root)
  return `# @bayarkit/core

The interface every [bayarkit](${repo}) gateway adapter implements, and \`confirmPayment\`: the one path to marking
an order paid. Zero runtime dependencies. [Bahasa Melayu](#bahasa-melayu)

\`\`\`bash
npm install @bayarkit/core @bayarkit/<gateway>
\`\`\`

- \`confirmPayment(gateway, callback, { reference, amount })\` — 1. the callback signature must verify; 2. the gateway
  is asked again (a valid signature can be replayed); 3. its own record must say paid, for this reference, this exact
  amount (integer sen) and currency. Returns \`{ ok: true, payment }\` or \`{ ok: false, reason, detail }\` with
  \`reason\` one of \`invalid_signature\`, \`not_paid\`, \`mismatch\`, \`gateway_error\`; it never throws.
- \`readCallback(request)\` — a callback from a Web-standard \`Request\`: fields (JSON, url-encoded or multipart) plus the
  raw body and headers, so both body-signed and header-signed gateways verify. \`callbackFromFields(fields)\` for
  frameworks that already parsed the body.
- \`checkoutResponse(payment, label?)\` — a 303 redirect, or an escaped self-submitting POST page for gateways that take
  a form; \`autoPostHtml\` is the page alone.
- \`toSen\` / \`toRinggit\` — exact decimal conversion, never through a float.
- \`GatewayError\` — messages quote the gateway's answer only, never a key.

Adapters: ${adapters.map((g) => `\`${g.adapter.package}\``).join(', ')}.

## Bahasa Melayu

Antara muka yang dilaksanakan oleh setiap adapter [bayarkit](${repo}), dan \`confirmPayment\`: satu-satunya jalan
untuk menanda pesanan dibayar. Sifar kebergantungan masa jalan.

- \`confirmPayment\` — tandatangan callback mesti sah; gateway ditanya semula; rekod gateway sendiri mesti kata dibayar,
  untuk rujukan ini, jumlah tepat ini (sen integer) dan mata wang ini. Tidak pernah melempar ralat.
- \`readCallback(request)\` — callback daripada \`Request\` piawai web, termasuk badan mentah dan pengepala.
- \`checkoutResponse(payment)\` — redirect 303, atau halaman borang POST yang dihantar sendiri.
- \`toSen\` / \`toRinggit\` — penukaran perpuluhan tepat, tidak pernah melalui float.

Dokumentasi penuh: [README.ms.md](${repo}/blob/main/README.ms.md).

MIT © ${root.author.replace(/\s*\(.*\)$/, '')}
`
}

function testingReadme(root, adapters) {
  const repo = repoUrl(root)
  return `# @bayarkit/testing

Fake Malaysian payment gateways and the [bayarkit](${repo}) conformance suite: test checkout and callbacks without real
money, in JavaScript or in any other language. [Bahasa Melayu](#bahasa-melayu)

\`\`\`bash
npm install --save-dev @bayarkit/testing
\`\`\`

Each fake answers like its gateway's API (in the shapes measured on the sandbox where one was measured) and signs
callbacks exactly as the gateway does: ${adapters.map((g) => `\`${g.adapter.fake}\``).join(', ')}.
Every fake has \`markPaid(id)\`, \`callbackFor(id)\` (a correctly signed callback) and \`tamper(callback)\`.

- \`gatewayConformance(name, setup)\` — the suite every adapter must pass (vitest, optional peer).
- \`npx bayarkit-fake <gateway>\` — one fake as a server for PHP, Python or Go tests. It prints one JSON line
  (\`url\`, \`control\`) and serves a control API: \`POST /paid/<id>\`, \`GET /callback/<id>\`,
  \`GET /callback/<id>/tampered\`. vitest is not needed for this.

## Bahasa Melayu

Gateway pembayaran Malaysia palsu dan set ujian keakuran [bayarkit](${repo}): uji checkout dan callback tanpa wang
sebenar, dalam JavaScript atau bahasa lain. Setiap fake menjawab seperti API gatewaynya dan menandatangani callback
sama seperti gateway itu. \`npx bayarkit-fake <gateway>\` menjalankan satu fake sebagai pelayan dengan API kawalan
(\`POST /paid/<id>\`, \`GET /callback/<id>\`, \`GET /callback/<id>/tampered\`) untuk ujian PHP, Python atau Go.

Dokumentasi penuh: [README.ms.md](${repo}/blob/main/README.ms.md).

MIT © ${root.author.replace(/\s*\(.*\)$/, '')}
`
}

/** [path, text] for every package's package.json and README.md. */
export function packageFiles(rootDir, registry) {
  const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const adapters = registry.gateways.filter((g) => g.adapter)
  const files = []
  const pkg = (dir) => JSON.parse(readFileSync(join(rootDir, 'packages', dir, 'package.json'), 'utf8'))
  files.push([
    join(rootDir, 'packages/core/package.json'),
    metadata('core', pkg('core'), root, ['confirm-payment']),
  ])
  files.push([join(rootDir, 'packages/core/README.md'), coreReadme(root, adapters)])
  files.push([
    join(rootDir, 'packages/testing/package.json'),
    metadata('testing', pkg('testing'), root, ['testing', 'fake', 'mock', 'conformance']),
  ])
  files.push([join(rootDir, 'packages/testing/README.md'), testingReadme(root, adapters)])
  for (const gw of adapters) {
    const dir = gw.adapter.package.replace('@bayarkit/', '')
    files.push([join(rootDir, 'packages', dir, 'package.json'), metadata(dir, pkg(dir), root, [gw.id])])
    files.push([join(rootDir, 'packages', dir, 'README.md'), adapterReadme(gw, root)])
  }
  return files
}
