import { createHmac } from 'node:crypto'
import { confirmPayment, GatewayError, readCallback } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFake2C2P } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { descriptionOf, parseAmount, signJwt, statusOf, toAmount, twoc2p, verifyJwt } from '../src/index.js'

const keys = { merchantId: 'JT07', secretKey: 'FAKE2C2PSECRETKEYFORTESTS0123456789ABCDEF' }

gatewayConformance('2c2p', async () => {
  const fake = await startFake2C2P(keys)
  return { fake, gateway: twoc2p({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

// Official test vectors (spec §4c). The keys are 2C2P's PUBLISHED demo-merchant keys, not secrets.
const TV1_KEY = '1F4EDB965BBB3094F791A83750FBDCDA3852131CB5218E21E4F42929A1975E60' // gitleaks:allow (2C2P public JWT guide demo key)
const TV1 =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtZXJjaGFudElEIjoiSlQwMSIsImludm9pY2VObyI6IjE1MjM5NTM2NjEiLCJkZXNjcmlwdGlvbiI6Iml0ZW0gMSIsImFtb3VudCI6MTAwMCwiY3VycmVuY3lDb2RlIjoiU0dEIn0.ElmhOULUdK63FnriSs2XyhH1LxULoTVIopTUuQ77DvA' // gitleaks:allow (2C2P public JWT guide sample)
const JT01_KEY = 'ECC4E54DBA738857B84A7EBC6B5DC7187B8DA68750E88AB53AAA41F548D6F2D9' // gitleaks:allow (2C2P public demo merchant JT01)
const TV2 =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3ZWJQYXltZW50VXJsIjoiaHR0cHM6Ly9zYW5kYm94LXBndy11aS4yYzJwLmNvbS9wYXltZW50LzQuMS8jL3Rva2VuL2tTQW9wczlad2hvczhoU1RTZUxUVWNKMFVRaVZhYTZ2Qmk1YXo5UWlmRUUlMmJSZDY1Y00zZE55ZjRXNWFZVmlxemthajVzTGRUbW9lSSUyYjAyMSUyZllyb0tEYjRSbVZvcWc4YVAlMmJoT0VKRDB0JTJiZyUzZCIsInBheW1lbnRUb2tlbiI6ImtTQW9wczlad2hvczhoU1RTZUxUVWNKMFVRaVZhYTZ2Qmk1YXo5UWlmRUUrUmQ2NWNNM2ROeWY0VzVhWVZpcXprYWo1c0xkVG1vZUkrMDIxL1lyb0tEYjRSbVZvcWc4YVAraE9FSkQwdCtnPSIsInJlc3BDb2RlIjoiMDAwMCIsInJlc3BEZXNjIjoiU3VjY2VzcyJ9.0YQthKwZEjR9giHWc3mkce9ngQnCNi0asXFWPHP_81k' // gitleaks:allow (2C2P public recipe sample)
const JT04_KEY = 'CD229682D3297390B9F66FF4020B758F4A5E625AF4992E5D75D311D6458B38E2' // gitleaks:allow (2C2P public demo merchant JT04)
const TV3 =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3ZWJQYXltZW50VXJsIjoiaHR0cHM6Ly9zYW5kYm94LXBndy11aS4yYzJwLmNvbS9wYXltZW50LzQuMS8jL3Rva2VuL2tTQW9wczlad2hvczhoU1RTZUxUVWNDcndjbnJuZEpVWmFuR0p5M2ZCRXNYQ2lZbXlud3hIdks1aDdYUEJhZEpxRDBuRzd2NjV0NU4yalBWcm53WDJqTDRudSUyYktLU2VnalVqRVJLQ3lXUGclM2QiLCJwYXltZW50VG9rZW4iOiJrU0FvcHM5Wndob3M4aFNUU2VMVFVjQ3J3Y25ybmRKVVphbkdKeTNmQkVzWENpWW15bnd4SHZLNWg3WFBCYWRKcUQwbkc3djY1dDVOMmpQVnJud1gyakw0bnUrS0tTZWdqVWpFUktDeVdQZz0iLCJyZXNwQ29kZSI6IjAwMDAiLCJyZXNwRGVzYyI6IlN1Y2Nlc3MifQ.Tq0GW7rQeA9jqjobPXAiDmscQ82qtAAUrcUaVYqTAhw' // gitleaks:allow (2C2P public Payment Token sample)
// Official frontend-return sample (D:api-payment-response-frontend): unsigned base64 JSON in a form field.
const FRONTEND_BODY =
  'paymentResponse=eyJsb2NhbGUiOm51bGwsImludm9pY2VObyI6IjA4MDIyMzE1MjMyMiIsImNoYW5uZWxDb2RlIjoiQ0MiLCJyZXNwQ29kZSI6IjIwMDAiLCJyZXNwRGVzYyI6IlRyYW5zYWN0aW9uIGlzIGNvbXBsZXRlZCwgcGxlYXNlIGRvIHBheW1lbnQgaW5xdWlyeSByZXF1ZXN0IGZvciBmdWxsIHBheW1lbnQgaW5mb3JtYXRpb24uIn0%3D'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const decode = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
/** The spec's warning: the key is the hex TEXT, not the bytes it spells. */
const hexDecodedMac = (key: string, input: string) =>
  createHmac('sha256', Buffer.from(key, 'hex')).update(input).digest('base64url')

describe('2c2p: official JWT test vectors (spec §4c)', () => {
  it('TV1: signJwt reproduces the JWT guide token byte for byte (amount 1000.00 serialises as 1000)', () => {
    const claims = {
      merchantID: 'JT01',
      invoiceNo: '1523953661',
      description: 'item 1',
      amount: 1000.0,
      currencyCode: 'SGD',
    }
    expect(signJwt(claims, TV1_KEY)).toBe(TV1)
    expect(verifyJwt(TV1, TV1_KEY)).toEqual({ ...claims, amount: 1000 })
  })

  it('TV2: the C# / Java recipe response verifies with the JT01 key', () => {
    const claims = verifyJwt(TV2, JT01_KEY)
    expect(claims).toMatchObject({ respCode: '0000', respDesc: 'Success' })
    expect(String(claims?.webPaymentUrl)).toMatch(/^https:\/\/sandbox-pgw-ui\.2c2p\.com\/payment\/4\.1\//)
  })

  it('TV3: the Payment Token sample verifies with the JT04 key (C5: NOT with JT01 as the PHP recipe does)', () => {
    expect(verifyJwt(TV3, JT04_KEY)).toMatchObject({ respCode: '0000' })
    expect(verifyJwt(TV3, JT01_KEY)).toBeNull()
  })

  it('the key is the hex STRING as ASCII: hex-decoding it fails every vector', () => {
    for (const [token, key] of [
      [TV1, TV1_KEY],
      [TV2, JT01_KEY],
      [TV3, JT04_KEY],
    ] as const) {
      const [h, p, s] = token.split('.')
      expect(hexDecodedMac(key, `${h}.${p}`)).not.toBe(s)
      expect(verifyJwt(token, key.toLowerCase())).toBeNull()
    }
  })

  it('refuses any algorithm other than HS256, a crit header and a non-canonical signature', () => {
    const [, p] = TV1.split('.')
    const sign = (header: unknown) => {
      const h = b64(header)
      return `${h}.${p}.${createHmac('sha256', TV1_KEY).update(`${h}.${p}`).digest('base64url')}`
    }
    expect(verifyJwt(sign({ alg: 'HS256', typ: 'JWT' }), TV1_KEY)).not.toBeNull()
    expect(verifyJwt(sign({ alg: 'HS512', typ: 'JWT' }), TV1_KEY)).toBeNull()
    expect(verifyJwt(sign({ alg: 'hs256', typ: 'JWT' }), TV1_KEY)).toBeNull()
    expect(verifyJwt(sign({ alg: 'HS256', crit: ['exp'] }), TV1_KEY)).toBeNull()
    expect(verifyJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`, TV1_KEY)).toBeNull()
    expect(verifyJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${p}`, TV1_KEY)).toBeNull()
    expect(verifyJwt(`${TV1}=`, TV1_KEY)).toBeNull()
    expect(verifyJwt(TV1, '')).toBeNull()
    expect(verifyJwt(42, TV1_KEY)).toBeNull()
  })
})

describe('2c2p: amounts are decimal ringgit at the edge, integer sen inside', () => {
  it('converts sen to the JSON number 2C2P expects, and every value round-trips', () => {
    expect(JSON.stringify({ amount: toAmount(1050) })).toBe('{"amount":10.5}')
    expect(JSON.stringify({ amount: toAmount(1) })).toBe('{"amount":0.01}')
    expect(JSON.stringify({ amount: toAmount(10) })).toBe('{"amount":0.1}')
    expect(JSON.stringify({ amount: toAmount(999_999_999) })).toBe('{"amount":9999999.99}')
    for (let sen = 0; sen <= 200_000; sen += 1) {
      const text = JSON.stringify(toAmount(sen))
      expect(/^\d+(\.\d{1,2})?$/.test(text) && parseAmount(JSON.parse(text)) === sen).toBe(true)
    }
    expect(() => toAmount(10.5)).toThrow(RangeError)
    expect(() => toAmount(1_000_000_000)).toThrow(RangeError)
  })

  it('parses numbers and strings (C6), five decimals, and never rounds sub-sen digits', () => {
    expect(parseAmount('2500.90000')).toBe(250_090)
    expect(parseAmount('230.87')).toBe(23_087)
    expect(parseAmount(230.87)).toBe(23_087)
    expect(parseAmount(1000)).toBe(100_000)
    expect(parseAmount('10.50000')).toBe(1050)
    expect(parseAmount('10.5')).toBe(1050)
    for (const bad of [
      '10.005',
      '10.00001',
      10.004,
      '1e3',
      '-1',
      '',
      ' ',
      '1,000.00',
      '.5',
      null,
      undefined,
      1e21,
    ]) {
      expect(parseAmount(bad)).toBeNaN()
    }
  })

  it("sends decimal major units, not the plugin's 12-digit zero-padded sen (C2)", async () => {
    const fake = await startFake2C2P(keys)
    try {
      const gw = twoc2p({ ...keys, environment: 'sandbox', baseUrl: fake.url })
      await gw.createPayment(sampleInput({ amount: 1050 }))
      const claims = fake.requests.at(-1)?.claims
      expect(claims?.amount).toBe(10.5)
      expect(claims?.currencyCode).toBe('MYR')
      expect(JSON.stringify(claims)).not.toContain('000000001050')
    } finally {
      await fake.close()
    }
  })
})

describe('2c2p: callbacks', () => {
  let fake: Awaited<ReturnType<typeof startFake2C2P>>
  let gw: ReturnType<typeof twoc2p>
  let input: ReturnType<typeof sampleInput>
  beforeAll(async () => {
    fake = await startFake2C2P(keys)
    gw = twoc2p({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    input = sampleInput()
    await gw.createPayment(input)
    fake.markPaid(input.reference)
  })
  afterAll(() => fake.close())

  it('reads the backend notification: claims verified, id = invoiceNo, claimed status from respCode', () => {
    expect(gw.verifyCallback(fake.callbackFor(input.reference))).toMatchObject({
      id: input.reference,
      reference: input.reference,
      claimedStatus: 'paid',
      raw: { amount: '10.50', cardNo: '411111XXXXXX1111', respCode: '0000' },
    })
    expect(gw.verifyCallback(fake.callbackFor(input.reference, { respCode: '4051' }))?.claimedStatus).toBe(
      'failed',
    )
  })

  it('verifies the JWT inside the body, so a re-serialised OUTER body still verifies (2C2P signs the JWT)', () => {
    const cb = fake.callbackFor(input.reference)
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody))
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).not.toBeNull()
    // …and from a framework that already parsed the JSON body (fields only).
    expect(gw.verifyCallback({ fields: cb.fields, rawBody: '', headers: {} })).not.toBeNull()
  })

  it('refuses re-encoded claims: the signature covers the claims segment exactly as 2C2P sent it', () => {
    const cb = fake.callbackFor(input.reference)
    const [h, p, s] = String(JSON.parse(cb.rawBody).payload).split('.')
    const claims = decode(p ?? '')
    // An amount re-typed from the string "10.50" (C6) to the number 10.5, everything else identical.
    const retyped = `${h}.${b64({ ...claims, amount: Number(claims.amount) })}.${s}`
    expect(gw.verifyCallback({ ...cb, rawBody: JSON.stringify({ payload: retyped }) })).toBeNull()
    const pretty = `${h}.${Buffer.from(JSON.stringify(claims, null, 2)).toString('base64url')}.${s}`
    expect(gw.verifyCallback({ ...cb, rawBody: JSON.stringify({ payload: pretty }) })).toBeNull()
  })

  it('refuses a notification signed with another key or for another merchant', () => {
    const other = twoc2p({
      ...keys,
      secretKey: `${keys.secretKey}X`,
      environment: 'sandbox',
      baseUrl: fake.url,
    })
    expect(other.verifyCallback(fake.callbackFor(input.reference))).toBeNull()
    expect(gw.verifyCallback(fake.callbackFor(input.reference, { merchantID: 'JT01' }))).toBeNull()
    expect(gw.verifyCallback(fake.callbackFor(input.reference, { invoiceNo: '../x' }))).toBeNull()
  })

  it('never trusts the frontend return: the official sample and the fake one are both refused (C8)', async () => {
    const req = new Request('https://shop.example/return', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: FRONTEND_BODY,
    })
    const official = await readCallback(req)
    expect(official.fields.paymentResponse).toBeTruthy()
    expect(gw.verifyCallback(official)).toBeNull()
    expect(gw.verifyCallback(fake.frontendFor(input.reference))).toBeNull()
  })

  it('refuses a callback in the legacy plugin format (C1: hash_value over concatenated fields)', () => {
    const fields = {
      version: '8.5',
      merchant_id: keys.merchantId,
      order_id: input.reference,
      invoice_no: input.reference,
      currency: '458',
      amount: '000000001050',
      payment_status: '000',
    }
    const hash = createHmac('sha256', keys.secretKey).update(Object.values(fields).join('')).digest('hex')
    const posted = { ...fields, hash_value: hash }
    expect(
      gw.verifyCallback({
        fields: posted,
        rawBody: new URLSearchParams(posted).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    ).toBeNull()
  })
})

describe('2c2p: payment states and errors', () => {
  let fake: Awaited<ReturnType<typeof startFake2C2P>>
  let gw: ReturnType<typeof twoc2p>
  beforeAll(async () => {
    fake = await startFake2C2P(keys)
    gw = twoc2p({ ...keys, environment: 'sandbox', baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('maps the documented response codes; only 0000 is paid (C9: dev-docs codes, not the agent-skills ones)', () => {
    const table: [string, string][] = [
      ['0000', 'paid'],
      ['0001', 'pending'],
      ['0004', 'pending'],
      ['2001', 'pending'],
      ['2002', 'pending'],
      ['0003', 'cancelled'],
      ['2003', 'failed'],
      ['4005', 'failed'],
      ['4051', 'failed'],
      ['9035', 'failed'],
      ['5009', 'expired'],
      ['9020', 'expired'],
      ['4110', 'unknown'],
      ['4120', 'unknown'],
      ['2000', 'unknown'],
      ['000', 'unknown'],
      ['', 'unknown'],
    ]
    for (const [code, status] of table) expect([code, statusOf(code)]).toEqual([code, status])
    expect(statusOf(0)).toBe('unknown')
  })

  it('reads every non-paid state from the inquiry, and confirmPayment refuses each', async () => {
    for (const [code, status] of [
      ['0001', 'pending'],
      ['0003', 'cancelled'],
      ['4005', 'failed'],
      ['9020', 'expired'],
      ['4120', 'unknown'],
    ] as const) {
      const input = sampleInput()
      await gw.createPayment(input)
      fake.setStatus(input.reference, code)
      const record = await gw.getPayment(input.reference)
      expect([code, record.status]).toEqual([code, status])
      expect(record.amount).toBe(input.amount)
      expect(record.paidAt).toBeUndefined()
      expect(await confirmPayment(gw, fake.callbackFor(input.reference), input)).toMatchObject({
        ok: false,
        reason: 'not_paid',
      })
    }
  })

  it('a paid inquiry gives sen, MYR and no invented paidAt (C7)', async () => {
    const input = sampleInput({ amount: 250_090 })
    await gw.createPayment(input)
    fake.markPaid(input.reference)
    const record = await gw.getPayment(input.reference)
    expect(record).toMatchObject({
      status: 'paid',
      amount: 250_090,
      currency: 'MYR',
      reference: input.reference,
    })
    expect(record.paidAt).toBeUndefined()
  })

  it('an unknown invoice (2002 not found) reads as pending, never paid', async () => {
    expect(await gw.getPayment('NEVERCREATED1')).toMatchObject({ status: 'pending', reference: '' })
  })

  it('both documented API versions work (C4)', async () => {
    const gw45 = twoc2p({ ...keys, environment: 'sandbox', baseUrl: fake.url, apiVersion: '4.5' })
    const input = sampleInput()
    const created = await gw45.createPayment(input)
    expect(created.url).toContain('/payment/4.5/')
    expect(fake.requests.at(-1)?.path).toBe('/payment/4.5/paymentToken')
    await gw.getPayment(input.reference)
    expect(fake.requests.at(-1)?.path).toBe('/payment/4.3/paymentInquiry')
  })

  it('quotes a plain (unsigned) error answer without ever reading it as a state, and leaks no key', async () => {
    const wrong = twoc2p({
      ...keys,
      secretKey: 'WRONGKEYWRONGKEY',
      environment: 'sandbox',
      baseUrl: fake.url,
    })
    const err = await wrong.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('9042')
    expect((err as GatewayError).message).toContain('Hash value mismatch')
    expect((err as GatewayError).message).not.toContain('WRONGKEY')
    await expect(wrong.getPayment('ANY1')).rejects.toBeInstanceOf(GatewayError)
  })

  it('refuses an answer whose signature does not verify', async () => {
    const forged = twoc2p({
      ...keys,
      environment: 'sandbox',
      baseUrl: fake.url,
      fetch: async () =>
        new Response(
          JSON.stringify({ payload: signJwt({ respCode: '0000', invoiceNo: 'X1' }, 'not-the-key') }),
        ),
    })
    await expect(forged.getPayment('X1')).rejects.toMatchObject({ code: 'BAD_SIGNATURE' })
  })

  it("refuses a duplicate invoiceNo with 2C2P's own code, and repeats the answer for the same idempotencyID", async () => {
    const input = sampleInput({ idempotencyKey: `idem-${Date.now()}` })
    const first = await gw.createPayment(input)
    expect(await gw.createPayment(input)).toEqual(first)
    await expect(gw.createPayment({ ...input, idempotencyKey: 'other-key' })).rejects.toMatchObject({
      code: '9015',
    })
    expect(fake.requests.at(-1)?.claims?.idempotencyID).toBe('other-key')
  })

  it('refuses expiresAt under the 20-minute default and never sends paymentExpiry (C10, timezone UNCONFIRMED)', async () => {
    await expect(
      gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() + 5 * 60_000) })),
    ).rejects.toMatchObject({ code: 'INVALID_EXPIRY' })
    await gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() + 3_600_000) }))
    expect(fake.requests.at(-1)?.claims).not.toHaveProperty('paymentExpiry')
  })

  it('refuses references 2C2P would not accept as invoiceNo instead of rewriting them', async () => {
    for (const reference of ['ORDER-1', 'a'.repeat(51), '']) {
      await expect(gw.createPayment(sampleInput({ reference }))).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      })
    }
  })

  it('HTML-encodes the description and keeps it within 250 characters', () => {
    expect(descriptionOf(' Kek <coklat> & "kopi" ')).toBe('Kek &lt;coklat&gt; &amp; &quot;kopi&quot;')
    const long = descriptionOf('&'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(250)
    expect(long.endsWith('&amp;')).toBe(true)
    expect(descriptionOf('   ')).toBe('Payment')
  })
})
