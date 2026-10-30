# Contributing

Thanks for helping. This library moves money, so the bar is evidence, not opinion.

## Set up

```bash
npm install          # Node.js 22.12 or newer
npm run gate         # typecheck, lint, tests, build, an install of the packed packages, and the PHP package
                     # (PHP 8.2+ and composer, or Docker: scripts/php-gate.sh uses a pinned image)
git config core.hooksPath .githooks   # secret scan + gate before every commit
```

## Adding what bayarkit knows about a gateway

No adapter needed for this. In `gateways/registry.json`, give the gateway its official sources (documentation pages,
or official SDK files on `raw.githubusercontent.com`) with `mustContain` words that only the real page contains; prefer
machine-readable versions (OpenAPI files, `llms.txt`, `.md` exports) over JavaScript-rendered pages. Write
`gateways/<id>/spec.md` with a source next to every fact and `UNCONFIRMED` where the docs are silent, add `gotchas`
(each with a source), then run `node tools/rujukan.mjs check --only <id>` twice (the second run must report no change)
and `node tools/rujukan.mjs skills`.

## Adding a gateway

1. **Read the gateway's official documentation in full**, not a blog summary. Note the date you read it.
2. **Write the fake first** in `packages/testing/src/fakes/<gateway>.ts`: it answers like the gateway's API and signs
   callbacks exactly as the gateway does. It implements `FakeGateway` (`markPaid`, `callbackFor`, `close`).
3. **Write the adapter** in `packages/<gateway>/src/index.ts`, implementing `Gateway` from `@bayarkit/core`:
   - amounts are integer sen in and out (the currency's smallest unit for a gateway without MYR, which declares its
     currency in `info.currency`);
   - `verifyCallback` returns `null` (never throws) for anything that does not verify, and compares signatures in
     constant time (`timingSafeEqualText`). It may return a Promise when the gateway verifies by an API call
     (PayPal); a rejected Promise is reported by `confirmPayment` as `gateway_error`, not as a forgery;
   - `refundPayment` is optional; when implemented, the conformance suite runs its refund cases (full, partial, more
     than is left refused before any request);
   - errors are `GatewayError`, and their messages quote the gateway's response only, never a key or secret;
   - `info.evidence` is `{ kind: 'docs', ... }` until the next step is done.
     Add `packages/testing/src/cli/<gateway>.ts` (test defaults for `bayarkit-fake`) and `scripts/smoke/<gateway>.mjs`
     (the packed smoke setup); `node tools/rujukan.mjs lint` fails without them. No shared list needs editing.
     The package README is generated from the gateway's `adapter` entry in `gateways/registry.json`
     (`node tools/rujukan.mjs skills`): `currency` when it does not charge MYR by default, and `flow` (`en`, `ms`,
     optional `code`) for a step the shared example lacks, such as PayPal's capture.
4. **Run the conformance suite** with `gatewayConformance('<gateway>', setup)` in `packages/<gateway>/test/`.
   Every test must pass.
5. **Measure the sandbox.** Run the adapter against the gateway's real sandbox, including one test-bank payment.
   Where the sandbox differs from the docs, change the fake first (so the tests fail), then the adapter, and record the
   difference in the adapter's header comment. Only then set `evidence.kind` to `'measured'` with the date.

A pull request that adds a gateway lists, in its description, which steps are done. Its fake must keep its callbacks
self-consistent (a form or JSON body says what its fields say, also after `tamper`): the conformance suite checks it.

## The PHP twin (`php/`)

toyyibPay, CHIP, Paddle and PayPal also exist in PHP. A rule changed in one twin is changed in the other in the same pull request; both
run the same conformance cases against the same `bayarkit-fake` gateways, and money parsing is pinned by
`packages/core/test/money-vectors.json`, which both test suites read. After changing `php/composer.json`, run
`bash scripts/php-compat.sh` (PHP 8.2 with the lowest dependencies, PHP 8.4 with the newest).

## The demo (`examples/demo`)

The demo runs on the fake gateways and sends no JavaScript to the browser (its CSP has no `script-src`). Its text lives
in `examples/demo/i18n/en.json` and `ms.json`; change both together. The "need help installing?" note on its pages and
in every README comes from `docs/support.json`: edit that file, then run `node tools/rujukan.mjs skills` to regenerate
the README sections (`npm run gate` fails while they are out of date). To see a change in a browser:

```bash
npm run build && npm run demo                      # http://127.0.0.1:4317
python3 scripts/demo-webkit.py /tmp/demo-shots     # WebKit (iPhone 13 + 1440 px), light and dark, EN and BM
python3 scripts/demo-shot.py                       # regenerates the README pictures in docs/demo/
```

## Before you open a pull request

- `npm run gate` passes.
- Any change to signature checks or `confirmPayment` comes with a test that fails without it.
- One topic per pull request.

## Security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
