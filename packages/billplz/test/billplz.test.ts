import { createHmac } from 'node:crypto'
import { GatewayError, readCallback } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeBillplz } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import { billplz, parsePaidAt, signingSource, xSignature } from '../src/index.js'

const keys = { secretKey: 'fake-secret', xSignatureKey: 'fake-x-signature', collectionId: 'fakecoll' }

gatewayConformance('billplz', async () => {
  const fake = await startFakeBillplz(keys)
  return { fake, gateway: billplz({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

// Official test vectors, support.billplz.com/api (spec §5). The keys are published sample keys, not secrets.
const DOC_KEY = 'S-s7b4yWpp9h7rrkNM1i3Z_g' // gitleaks:allow
const CALLBACK = {
  id: 'zq0tm2wc',
  collection_id: 'yhx5t1pp',
  paid: 'true',
  state: 'paid',
  amount: '100',
  paid_amount: '100',
  due_at: '2018-9-27',
  email: 'tester@test.com',
  mobile: '',
  name: 'TESTER',
  url: 'http://www.billplz-sandbox.com/bills/zq0tm2wc',
  paid_at: '2018-09-27 15:15:09 +0800',
}
const CALLBACK_SOURCE =
  'amount100|collection_idyhx5t1pp|due_at2018-9-27|emailtester@test.com|idzq0tm2wc|mobile|nameTESTER|paid_amount100|paid_at2018-09-27 15:15:09 +0800|paidtrue|statepaid|urlhttp://www.billplz-sandbox.com/bills/zq0tm2wc'
const CALLBACK_SIG = '0fe0a20b8d557eeae570377783d062a3816a9ea80f368860bacfa7ec3ca4d00e'
const REDIRECT_QUERY =
  'billplz[id]=zq0tm2wc&billplz[paid]=true&billplz[paid_at]=2018-09-27%2015%3A15%3A09%20%2B0800'
const REDIRECT_SOURCE = 'billplzidzq0tm2wc|billplzpaid_at2018-09-27 15:15:09 +0800|billplzpaidtrue'
const REDIRECT_SIG = '4aab095fe5a39b1d534500988f9a0cb085cd1b6d5bbb55dd4e02ea6fa102b47b'

/** The WRONG reading of the docs ("sort keys"): values ordered by key name. */
const keyOnlySort = (key: string, fields: Record<string, string>) =>
  createHmac('sha256', key)
    .update(
      Object.keys(fields)
        .map((k) => [k.replace(/[[\]]/g, ''), fields[k]] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}${v}`)
        .join('|'),
    )
    .digest('hex')

const docGateway = () =>
  billplz({
    secretKey: 'unused',
    xSignatureKey: DOC_KEY,
    collectionId: 'yhx5t1pp',
    environment: 'sandbox',
  })

describe('billplz: X Signature reproduces all three official test vectors', () => {
  it('callback vector', () => {
    expect(signingSource(CALLBACK)).toBe(CALLBACK_SOURCE)
    expect(xSignature(DOC_KEY, CALLBACK)).toBe(CALLBACK_SIG)
    const cb = docGateway().verifyCallback({
      fields: { ...CALLBACK, x_signature: CALLBACK_SIG },
      rawBody: '',
      headers: {},
    })
    expect(cb).toMatchObject({ id: 'zq0tm2wc', reference: '', claimedStatus: 'paid' })
  })

  it('redirect vector (decoded nested keys, parent key prepended)', () => {
    const fields = Object.fromEntries(new URLSearchParams(REDIRECT_QUERY))
    expect(fields['billplz[paid_at]']).toBe('2018-09-27 15:15:09 +0800')
    expect(signingSource(fields)).toBe(REDIRECT_SOURCE)
    expect(xSignature(DOC_KEY, fields)).toBe(REDIRECT_SIG)
  })

  it('generic vector', () => {
    const fields = {
      amount: '200',
      callback_url: 'https://example.com/webhook',
      collection_id: 'inbmmepb',
      description: 'testing',
      email: 'api@billplz.com',
      name: 'Michael',
    }
    expect(signingSource(fields)).toBe(
      'amount200|callback_urlhttps://example.com/webhook|collection_idinbmmepb|descriptiontesting|emailapi@billplz.com|nameMichael',
    )
    expect(xSignature('abc123cde456', fields)).toBe(
      'ef5e54a22af0925cba88fab467119742e90262e3646eea1dee3949938daf3a38',
    )
  })

  it('sorting by key name alone (the docs\' "sort keys" wording) gives a different, wrong signature', () => {
    const wrongCallback = keyOnlySort(DOC_KEY, CALLBACK)
    expect(wrongCallback.startsWith('0d7b90c7')).toBe(true)
    expect(wrongCallback).not.toBe(CALLBACK_SIG)
    const wrongRedirect = keyOnlySort(DOC_KEY, Object.fromEntries(new URLSearchParams(REDIRECT_QUERY)))
    expect(wrongRedirect.startsWith('5c8f760d')).toBe(true)
    // …and the adapter refuses a callback signed that way.
    expect(
      docGateway().verifyCallback({
        fields: { ...CALLBACK, x_signature: wrongCallback },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
  })

  it('every signed field counts: changing one value breaks the official signature', () => {
    const gw = docGateway()
    expect(
      gw.verifyCallback({
        fields: { ...CALLBACK, amount: '1', x_signature: CALLBACK_SIG },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
    // Extra Payment Completion Information fields are signed too, so adding one without re-signing fails.
    expect(
      gw.verifyCallback({
        fields: { ...CALLBACK, transaction_status: 'completed', x_signature: CALLBACK_SIG },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
  })
})

describe('billplz: redirect query', () => {
  it('verifies the official redirect read from a real return URL', async () => {
    const req = new Request(
      `https://shop.example/return?${REDIRECT_QUERY}&billplz[x_signature]=${REDIRECT_SIG}&order=A1`,
    )
    const cb = docGateway().verifyCallback(await readCallback(req))
    expect(cb).toMatchObject({ id: 'zq0tm2wc', reference: '', claimedStatus: 'paid' })
  })

  it('refuses a redirect whose paid flag was flipped', async () => {
    const req = new Request(
      `https://shop.example/return?${REDIRECT_QUERY.replace('paid]=true', 'paid]=false')}&billplz[x_signature]=${REDIRECT_SIG}`,
    )
    expect(docGateway().verifyCallback(await readCallback(req))).toBeNull()
  })

  it('verifies the fake redirect, refuses it tampered, and confirmPayment still asks the gateway', async () => {
    const fake = await startFakeBillplz(keys)
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput())
    const redirect = fake.redirectFor(created.id)
    expect(gw.verifyCallback(redirect)).toMatchObject({ id: created.id, claimedStatus: 'paid' })
    expect(gw.verifyCallback(fake.tamper(redirect))).toBeNull()
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    await fake.close()
  })

  it('refuses unsigned callbacks (accounts still on the "Basic" variant)', () => {
    const { x_signature: _none, ...unsigned } = { ...CALLBACK, x_signature: '' }
    expect(docGateway().verifyCallback({ fields: unsigned, rawBody: '', headers: {} })).toBeNull()
    expect(
      docGateway().verifyCallback({ fields: { 'billplz[id]': 'zq0tm2wc' }, rawBody: '', headers: {} }),
    ).toBeNull()
  })
})

describe('billplz: bills', () => {
  it('requires an email or a mobile number with a country code', async () => {
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    for (const customer of [{ name: 'A' }, { name: 'A', phone: '0123456789' }]) {
      const err = await gw.createPayment(sampleInput({ customer })).catch((e) => e)
      expect(err).toBeInstanceOf(GatewayError)
      expect(err.code).toBe('CONTACT_REQUIRED')
    }
  })

  it('accepts a mobile number alone, and sends a local number only when an email is there too', async () => {
    const fake = await startFakeBillplz(keys)
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    await gw.createPayment(sampleInput({ customer: { name: 'A', phone: '+60 12-345 6789' } }))
    expect(fake.requests.at(-1)?.body).toMatchObject({ mobile: '+60123456789' })
    expect(fake.requests.at(-1)?.body).not.toHaveProperty('email')
    await gw.createPayment(
      sampleInput({ customer: { name: 'A', email: 'a@example.com', phone: '0123456789' } }),
    )
    expect(fake.requests.at(-1)?.body).not.toHaveProperty('mobile')
    await fake.close()
  })

  it('sends integer sen, the reference in reference_1, and a description trimmed to 200 characters', async () => {
    const fake = await startFakeBillplz(keys)
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput({ amount: 2500, description: 'x'.repeat(250) })
    await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.contentType).toBe('application/x-www-form-urlencoded')
    expect(sent?.body).toMatchObject({
      collection_id: keys.collectionId,
      amount: '2500',
      reference_1_label: 'Reference',
      reference_1: input.reference,
      redirect_url: input.returnUrl,
      callback_url: input.callbackUrl,
      description: 'x'.repeat(200),
    })
    await fake.close()
  })

  it('refuses a reference longer than reference_1 allows instead of truncating it', async () => {
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    await expect(gw.createPayment(sampleInput({ reference: 'R'.repeat(121) }))).rejects.toThrow(/1–120/)
  })

  it('authenticates with HTTP Basic: secret key as username, empty password', async () => {
    let seen = ''
    const gw = billplz({
      secretKey: '73eb57f0-7d4e-42b9-a544-aeac6e4b0f81', // gitleaks:allow — sample key from the official docs
      xSignatureKey: 'x',
      collectionId: 'c',
      environment: 'sandbox',
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers).get('authorization') ?? ''
        return Response.json({ id: 'abc123', url: 'https://www.billplz-sandbox.com/bills/abc123' })
      },
    })
    await gw.createPayment(sampleInput())
    expect(seen).toBe('Basic NzNlYjU3ZjAtN2Q0ZS00MmI5LWE1NDQtYWVhYzZlNGIwZjgxOg==') // gitleaks:allow
  })

  it('a wrong secret key is a 401 GatewayError that does not leak the key', async () => {
    const wrongKey = `${keys.secretKey}-wrong`
    const fake = await startFakeBillplz(keys)
    const gw = billplz({ ...keys, secretKey: wrongKey, environment: 'sandbox', baseUrl: fake.url })
    const err = await gw.createPayment(sampleInput()).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.status).toBe(401)
    expect(err.message).not.toContain(wrongKey)
    await fake.close()
  })

  it('maps paid → paid, deleted → cancelled, due → pending', async () => {
    const fake = await startFakeBillplz(keys)
    const gw = billplz({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const a = await gw.createPayment(sampleInput())
    expect((await gw.getPayment(a.id)).status).toBe('pending')
    await gw.deleteBill(a.id)
    expect((await gw.getPayment(a.id)).status).toBe('cancelled')
    // A deleted bill comes back when a payment in flight completes.
    fake.markPaid(a.id)
    expect((await gw.getPayment(a.id)).status).toBe('paid')
    const b = await gw.createPayment(sampleInput({ amount: 4321 }))
    fake.markPaid(b.id)
    const record = await gw.getPayment(b.id)
    expect(record).toMatchObject({ status: 'paid', amount: 4321, currency: 'MYR', fee: null })
    await expect(gw.deleteBill(b.id)).rejects.toMatchObject({ status: 422 })
    await fake.close()
  })

  it('reads paid_at only in the documented callback format', () => {
    expect(parsePaidAt('2018-09-27 15:15:09 +0800')?.toISOString()).toBe('2018-09-27T07:15:09.000Z')
    expect(parsePaidAt('2018-9-27')).toBeUndefined()
    expect(parsePaidAt(null)).toBeUndefined()
  })
})
