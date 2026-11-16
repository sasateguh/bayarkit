// Against the real Sampan Pay, mainnet: skipped unless BAYARKIT_SAMPAN_LIVE=1. It creates ONE invoice (default
// USD 0.20) and reads it back; it pays nothing. Paying it, and confirming it from the webhook, is a manual step.
//   BAYARKIT_SAMPAN_LIVE=1 BAYARKIT_SAMPAN_MERCHANT=bitcoincash:z… npx vitest run packages/sampan/test/live.test.ts
// Optional: BAYARKIT_SAMPAN_LIVE_CENTS (20), BAYARKIT_SAMPAN_URL, BAYARKIT_SAMPAN_WEBHOOK_URL,
// BAYARKIT_SAMPAN_WEBHOOK_SECRET (a fresh random whsec_ when unset; never printed).
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sampan } from '../src/index.js'

const env = process.env
const live = env.BAYARKIT_SAMPAN_LIVE === '1'

describe.skipIf(!live)('sampan: live invoice on mainnet (BAYARKIT_SAMPAN_LIVE=1)', () => {
  it('creates an invoice and reads it back as pending, for this reference, amount and currency', async () => {
    const amount = Number(env.BAYARKIT_SAMPAN_LIVE_CENTS ?? '20')
    const gateway = sampan({
      merchantAddress: env.BAYARKIT_SAMPAN_MERCHANT ?? '',
      webhookSecret: env.BAYARKIT_SAMPAN_WEBHOOK_SECRET ?? `whsec_${randomBytes(24).toString('base64')}`,
      ...(env.BAYARKIT_SAMPAN_URL ? { baseUrl: env.BAYARKIT_SAMPAN_URL } : {}),
    })
    const reference = `BKLIVE${Date.now()}`
    const created = await gateway.createPayment({
      reference,
      amount,
      currency: 'USD',
      description: 'bayarkit sampan adapter live test',
      returnUrl: 'https://example.com/return',
      callbackUrl: env.BAYARKIT_SAMPAN_WEBHOOK_URL ?? 'https://example.com/bayarkit-sampan-callback',
    })
    const raw = created.raw as { address: string; bip21: string }
    console.log(`sampan live: invoice ${created.id} · ${created.url} · ${raw.bip21}`)
    const record = await gateway.getPayment(created.id)
    expect(record).toMatchObject({ id: created.id, reference, amount, currency: 'USD', status: 'pending' })
  })
})
