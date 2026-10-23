# Contributing

Thanks for helping. This library moves money, so the bar is evidence, not opinion.

## Set up

```bash
npm install          # Node.js 22.12 or newer
npm run gate         # typecheck, lint, tests, build, and an install of the packed packages
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
   - amounts are integer sen in and out;
   - `verifyCallback` returns `null` (never throws) for anything that does not verify, and compares signatures in
     constant time (`timingSafeEqualText`);
   - errors are `GatewayError`, and their messages quote the gateway's response only, never a key or secret;
   - `info.evidence` is `{ kind: 'docs', ... }` until the next step is done.
4. **Run the conformance suite** with `gatewayConformance('<gateway>', setup)` in `packages/<gateway>/test/`.
   Every test must pass.
5. **Measure the sandbox.** Run the adapter against the gateway's real sandbox, including one test-bank payment.
   Where the sandbox differs from the docs, change the fake first (so the tests fail), then the adapter, and record the
   difference in the adapter's header comment. Only then set `evidence.kind` to `'measured'` with the date.

A pull request that adds a gateway lists, in its description, which steps are done.

## Before you open a pull request

- `npm run gate` passes.
- Any change to signature checks or `confirmPayment` comes with a test that fails without it.
- One topic per pull request.

## Security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
