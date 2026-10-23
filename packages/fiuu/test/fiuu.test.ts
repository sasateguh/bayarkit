import { createHash } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError, readCallback } from '@bayarkit/core'
import { type FakeFiuu, gatewayConformance, sampleInput, startFakeFiuu } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CALLBACK_ACK,
  fiuu,
  parsePaymentId,
  parseQueryAnswer,
  paymentSkey,
  queryVrfKey,
  senOf,
  statusOf,
  vcode,
} from '../src/index.js'

const keys = { merchantId: 'SB_fakemerchant', verifyKey: 'fake-verify-key', secretKey: 'fake-secret-key' }
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

gatewayConformance('fiuu', async () => {
  const fake = await startFakeFiuu(keys)
  return { fake, gateway: fiuu({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

gatewayConformance('fiuu (extended vcode)', async () => {
  const fake = await startFakeFiuu({ ...keys, extendedVcode: true })
  return {
    fake,
    gateway: fiuu({ ...keys, environment: 'sandbox', baseUrl: fake.url, extendedVcode: true }),
  }
})

// SPEC p20: the ONLY official test vector Fiuu publishes. The key is the spec's printed sample, not a credential.
const DOC_VERIFY_KEY = 'f5bb0c8de146c67b44babbf4e6584cc0' // gitleaks:allow (sample Verify Key printed in Fiuu's public spec PDF p20)
const DOC = { amount: '27.60', merchantId: 'ACME', orderid: 'OD8842', currency: 'MYR' }

describe('fiuu: vcode reproduces the official test vector (SPEC p20)', () => {
  it('extended vcode (with currency) = 5bf33e6500a53830d4f80087b67e13de', () => {
    expect(vcode({ ...DOC, verifyKey: DOC_VERIFY_KEY, extended: true })).toBe(
      '5bf33e6500a53830d4f80087b67e13de',
    )
  })

  it('standard vcode leaves the currency out (derived, not published)', () => {
    expect(vcode({ ...DOC, verifyKey: DOC_VERIFY_KEY })).toBe('511b10ef1fe0f678ee85aaafc1b36934')
    expect(vcode({ ...DOC, verifyKey: DOC_VERIFY_KEY, extended: false })).toBe(
      md5(`27.60ACMEOD8842${DOC_VERIFY_KEY}`),
    )
  })

  it('createPayment puts the official vcode in the URL, from sen, for each mode', async () => {
    const make = (extendedVcode: boolean) =>
      fiuu({
        merchantId: 'ACME',
        verifyKey: DOC_VERIFY_KEY,
        secretKey: 'x-secret',
        environment: 'production',
        extendedVcode,
      })
    const input = sampleInput({ reference: 'OD8842', amount: 2760 })
    const ext = new URL((await make(true).createPayment(input)).url)
    expect(ext.origin + ext.pathname).toBe('https://pay.fiuu.com/RMS/pay/ACME/')
    expect(ext.searchParams.get('amount')).toBe('27.60')
    expect(ext.searchParams.get('vcode')).toBe('5bf33e6500a53830d4f80087b67e13de')
    const std = new URL((await make(false).createPayment(input)).url)
    expect(std.searchParams.get('vcode')).toBe('511b10ef1fe0f678ee85aaafc1b36934')
  })
})

describe('fiuu: payment skey (SPEC p21)', () => {
  // NOT an official vector (Fiuu publishes none for skey): computed from the SPEC p21 formula, recorded in spec.md §5.
  const DERIVED = {
    tranID: '30365812',
    orderid: 'OD8842',
    status: '00',
    domain: 'ACME',
    amount: '27.60',
    currency: 'MYR',
    paydate: '2026-10-23 15:00:00',
    appcode: '',
  }
  const docGateway = () =>
    fiuu({ merchantId: 'ACME', verifyKey: 'v-key', secretKey: 's3cr3tKeyExample', environment: 'sandbox' })

  it('derived vector: pre_skey and skey', () => {
    expect(md5('30365812OD884200ACME27.60MYR')).toBe('030661a134df99624be9b4441affd9c9')
    expect(paymentSkey(DERIVED, 's3cr3tKeyExample')).toBe('eea640eb500116cda0d008cd30166f63')
  })

  it('verifies the derived vector with an empty appcode, and ids carry orderid, amount and tranID', () => {
    const cb = docGateway().verifyCallback({
      fields: { ...DERIVED, skey: 'eea640eb500116cda0d008cd30166f63', nbcb: '2' },
      rawBody: '',
      headers: {},
    })
    expect(cb).toMatchObject({ id: 'OD8842:27.60:30365812', reference: 'OD8842', claimedStatus: 'paid' })
    expect(parsePaymentId(cb?.id ?? '')).toEqual({ orderid: 'OD8842', amount: '27.60', tranID: '30365812' })
  })

  it('upper-case skey hex is accepted; the verify key (not the secret key) is refused', () => {
    const gw = docGateway()
    const upper = { ...DERIVED, skey: 'EEA640EB500116CDA0D008CD30166F63' }
    expect(gw.verifyCallback({ fields: upper, rawBody: '', headers: {} })).not.toBeNull()
    const withVerifyKey = { ...DERIVED, skey: paymentSkey(DERIVED, 'v-key') }
    expect(gw.verifyCallback({ fields: withVerifyKey, rawBody: '', headers: {} })).toBeNull()
  })

  it('a callback for another merchant (domain) is refused even when signed with the same secret', () => {
    const other = { ...DERIVED, domain: 'OTHER' }
    const cb = { ...other, skey: paymentSkey(other, 's3cr3tKeyExample') }
    expect(docGateway().verifyCallback({ fields: cb, rawBody: '', headers: {} })).toBeNull()
  })
})

describe('fiuu: against the fake', () => {
  let fake: FakeFiuu
  const gw = () => fiuu({ ...keys, environment: 'sandbox', baseUrl: fake.url })
  beforeAll(async () => {
    fake = await startFakeFiuu(keys)
  })
  afterAll(async () => {
    await fake.close()
  })

  it('the payment URL is accepted by the fake payment page (vcode, mandatory fields)', async () => {
    const created = await gw().createPayment(sampleInput())
    const html = await (await fetch(created.url)).text()
    expect(html).toContain('Fake Fiuu payment page')
  })

  it('standard vcode against a merchant with extended mode on → P03 on the page (C13: the PHP SDK way)', async () => {
    const extended = await startFakeFiuu({ ...keys, extendedVcode: true })
    try {
      const created = await fiuu({ ...keys, environment: 'sandbox', baseUrl: extended.url }).createPayment(
        sampleInput(),
      )
      expect(await (await fetch(created.url)).text()).toContain('P03')
    } finally {
      await extended.close()
    }
  })

  it('missing buyer details are left out with guest_checkout=1, and the page still accepts it', async () => {
    const created = await gw().createPayment(
      sampleInput({ customer: { name: 'Ali', email: 'a@example.com' } }),
    )
    const url = new URL(created.url)
    expect(url.searchParams.get('guest_checkout')).toBe('1')
    expect(url.searchParams.has('bill_mobile')).toBe(false)
    expect(await (await fetch(created.url)).text()).toContain('Fake Fiuu payment page')
    const full = new URL((await gw().createPayment(sampleInput())).url)
    expect(full.searchParams.has('guest_checkout')).toBe(false)
  })

  it('getPayment by the created id asks q_by_oid; before any attempt that is Q203, a GatewayError', async () => {
    const created = await gw().createPayment(sampleInput())
    await expect(gw().getPayment(created.id)).rejects.toMatchObject({ code: 'Q203' })
    await fetch(created.url)
    expect(await gw().getPayment(created.id)).toMatchObject({ status: 'pending' })
    expect(fake.requests.at(-1)?.path).toBe('/RMS/query/q_by_oid.php')
  })

  it('a callback id asks q_by_tid for that exact transaction', async () => {
    const input = sampleInput()
    const created = await gw().createPayment(input)
    fake.markPaid(created.id)
    const cb = gw().verifyCallback(fake.callbackFor(created.id))
    expect(cb?.id).toMatch(/^ORDER\d+:10\.50:\d+$/)
    const record = await gw().getPayment(cb?.id ?? '')
    expect(record).toMatchObject({
      status: 'paid',
      reference: input.reference,
      amount: 1050,
      currency: 'MYR',
    })
    expect(fake.requests.at(-1)).toMatchObject({ path: '/RMS/q_by_tid.php' })
    expect(fake.requests.at(-1)?.fields.type).toBe('2')
  })

  it('verifies from the raw form body alone, and through readCallback (values not URL-encoded)', async () => {
    const created = await gw().createPayment(sampleInput())
    const posted = fake.callbackFor(created.id)
    expect(posted.rawBody).toContain('paydate=20') // space kept as is: "not URL encoded" (SPEC p56)
    expect(gw().verifyCallback({ fields: {}, rawBody: posted.rawBody, headers: {} })).not.toBeNull()
    const request = new Request('https://shop.example/callback', {
      method: 'POST',
      headers: posted.headers,
      body: posted.rawBody,
    })
    expect(gw().verifyCallback(await readCallback(request))).not.toBeNull()
  })

  it('status mapping from the requery: only captured/settled is paid', async () => {
    const cases: [code: '00' | '11' | '22', name: string, expected: string][] = [
      ['00', 'captured', 'paid'],
      ['00', 'settled', 'paid'],
      ['00', 'authorized', 'pending'],
      ['00', '', 'unknown'],
      ['11', 'failed', 'failed'],
      ['11', 'cancelled', 'cancelled'],
      ['11', 'canceled', 'cancelled'],
      ['11', 'chargeback', 'failed'],
      ['22', 'pending', 'pending'],
      ['22', 'Authorized-FPXb2b', 'pending'],
    ]
    for (const [code, name, expected] of cases) {
      const input = sampleInput()
      const created = await gw().createPayment(input)
      const body = fake.callbackFor(created.id)
      fake.setStatus(created.id, code, name)
      const result = await confirmPayment(gw(), body, input)
      expect(result.ok ? 'paid' : result.payment?.status, `${code} ${name}`).toBe(expected)
    }
  })

  it('a signed callback saying failed or pending (DuitNow account enquiry) is never paid', async () => {
    for (const override of [{ status: '11' }, { status: '22', extraP: '{"account_enquiry":"true"}' }]) {
      const input = sampleInput()
      const created = await gw().createPayment(input)
      const cb = fake.callbackFor(created.id, override)
      expect(gw().verifyCallback(cb)?.claimedStatus).not.toBe('paid')
      expect(await confirmPayment(gw(), cb, input)).toMatchObject({ ok: false, reason: 'not_paid' })
    }
  })

  it('reports nothing it cannot verify: VrfKey mismatch is a GatewayError', async () => {
    const answer = {
      StatCode: '00',
      StatName: 'captured',
      TranID: '1234567890',
      Amount: '10.50',
      Domain: keys.merchantId,
      OrderID: 'ORDERX',
      Currency: 'MYR',
    }
    const stub = (vrf: string) =>
      fiuu({
        ...keys,
        environment: 'sandbox',
        fetch: async () => new Response(JSON.stringify({ ...answer, VrfKey: vrf })),
      })
    const good = queryVrfKey('10.50', keys.secretKey, keys.merchantId, '1234567890', '00')
    expect(await stub(good).getPayment('ORDERX:10.50:1234567890')).toMatchObject({
      status: 'paid',
      amount: 1050,
    })
    await expect(stub(md5('forged')).getPayment('ORDERX:10.50:1234567890')).rejects.toMatchObject({
      code: 'VRFKEY',
    })
    // The spec's own sample VrfKey is 25 characters, not an MD5 (SPEC p74): never accepted.
    const SPEC_SAMPLE_VRFKEY = '456cf69e5bddfe8ed47371096' // gitleaks:allow (truncated sample, Fiuu's public spec PDF p74)
    await expect(stub(SPEC_SAMPLE_VRFKEY).getPayment('ORDERX:10.50:1234567890')).rejects.toMatchObject({
      code: 'VRFKEY',
    })
    // A correctly signed answer about ANOTHER transaction is refused too.
    const other = queryVrfKey('10.50', keys.secretKey, keys.merchantId, '999', '00')
    const swapped = fiuu({
      ...keys,
      environment: 'sandbox',
      fetch: async () => new Response(JSON.stringify({ ...answer, TranID: '999', VrfKey: other })),
    })
    await expect(swapped.getPayment('ORDERX:10.50:1234567890')).rejects.toMatchObject({ code: 'MISMATCH' })
  })

  it('error answers quote Fiuu, never a key', async () => {
    const echo = fiuu({
      ...keys,
      environment: 'sandbox',
      fetch: async (_url, init) =>
        new Response(`Error: Q202 Incorrect skey for ${String(init?.body)} ${keys.secretKey}`, {
          status: 200,
        }),
    })
    const err = await echo.getPayment('ORDERX:10.50').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('Q202')
    expect((err as GatewayError).message).not.toContain(keys.secretKey)
    expect((err as GatewayError).message).not.toContain(keys.verifyKey)
  })

  it('validates before building a URL', async () => {
    const g = gw()
    for (const reference of ['ORD_1', 'ORD 1', 'A'.repeat(33), '']) {
      await expect(g.createPayment(sampleInput({ reference }))).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      })
    }
    // The spec's own example orderid has a dash.
    await expect(g.createPayment(sampleInput({ reference: 'BH2018-09rev' }))).resolves.toMatchObject({
      id: 'BH2018-09rev:10.50',
    })
    await expect(g.createPayment(sampleInput({ amount: 100 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    })
    await expect(g.createPayment(sampleInput({ amount: 101 }))).resolves.toBeTruthy()
    await expect(
      g.createPayment(sampleInput({ expiresAt: new Date(Date.now() - 1000) })),
    ).rejects.toMatchObject({
      code: 'INVALID_EXPIRY',
    })
    const expiring = new URL(
      (await g.createPayment(sampleInput({ expiresAt: new Date('2099-12-31T23:59:59.123Z') }))).url,
    )
    expect(expiring.searchParams.get('PaymentExpirationTime')).toBe('2099-12-31T23:59:59Z')
    await expect(g.getPayment('../../etc')).rejects.toMatchObject({ code: 'INVALID_ID' })
    expect(() => fiuu({ ...keys, merchantId: 'a/b', environment: 'sandbox' })).toThrow(GatewayError)
  })

  it('exports the callback acknowledgement exactly as the plugins send it', () => {
    expect(CALLBACK_ACK).toBe('CBTOKEN:MPSTATOK')
  })
})

describe('fiuu: contradictions in the official material (spec §10)', () => {
  let fake: FakeFiuu
  const gw = () => fiuu({ ...keys, environment: 'sandbox', baseUrl: fake.url })
  beforeAll(async () => {
    fake = await startFakeFiuu(keys)
  })
  afterAll(async () => {
    await fake.close()
  })

  it('C11: a callback currency "RM" is verified as posted and reported as MYR; rewriting it first fails', async () => {
    const created = await gw().createPayment(sampleInput())
    const cb = fake.callbackFor(created.id, { currency: 'RM' })
    expect(gw().verifyCallback(cb)?.raw.currency).toBe('MYR')
    const rewritten: CallbackInput = { ...cb, fields: { ...cb.fields, currency: 'MYR' } }
    expect(gw().verifyCallback(rewritten)).toBeNull()
  })

  it('C11: a requery answer in RM is reported as MYR', async () => {
    const vrf = queryVrfKey('10.50', keys.secretKey, keys.merchantId, '1234567890', '00')
    const g = fiuu({
      ...keys,
      environment: 'sandbox',
      fetch: async () =>
        new Response(
          `StatCode: 00\nStatName: captured\nTranID: 1234567890\nAmount: 10.50\nDomain: ${keys.merchantId}\nVrfKey: ${vrf}\nOrderID: ORDERX\nCurrency: RM`,
        ),
    })
    expect(await g.getPayment('ORDERX:10.50:1234567890')).toMatchObject({ currency: 'MYR', status: 'paid' })
  })

  it('raw strings, not reformatted ones: "27.6" for a callback signed over "27.60" fails; "500" signed as posted passes', async () => {
    const created = await gw().createPayment(sampleInput({ amount: 2760 }))
    const cb = fake.callbackFor(created.id)
    expect(cb.fields.amount).toBe('27.60')
    expect(gw().verifyCallback(cb)).not.toBeNull()
    expect(gw().verifyCallback({ ...cb, fields: { ...cb.fields, amount: '27.6' } })).toBeNull()
    const integer = fake.callbackFor(created.id, { amount: '500' })
    expect(gw().verifyCallback(integer)?.id).toMatch(/:500\.00:/)
  })

  it('C12: a paydate in another format is hashed as posted (never parsed or reformatted)', async () => {
    const created = await gw().createPayment(sampleInput())
    const cb = fake.callbackFor(created.id, { paydate: '20261023 15:00:00' })
    expect(gw().verifyCallback(cb)).not.toBeNull()
    expect(
      gw().verifyCallback({ ...cb, fields: { ...cb.fields, paydate: '2026-10-23 15:00:00' } }),
    ).toBeNull()
  })

  it('C13: extended mode appends the currency; the PHP SDK form (without it) is a different vcode', () => {
    const parts = { ...DOC, verifyKey: DOC_VERIFY_KEY }
    expect(vcode({ ...parts, extended: true })).not.toBe(vcode({ ...parts, extended: false }))
  })

  it('C14: tranIDs of 8 and 20 digits are accepted', async () => {
    const created = await gw().createPayment(sampleInput())
    for (const tranID of ['10645406', '12345678901234567890']) {
      expect(gw().verifyCallback(fake.callbackFor(created.id, { tranID }))?.id).toMatch(
        new RegExp(`:${tranID}$`),
      )
    }
    expect(gw().verifyCallback(fake.callbackFor(created.id, { tranID: '1'.repeat(21) }))).toBeNull()
  })

  it('C15: an answer amount with a comma is unreadable, so confirmPayment reports a mismatch', async () => {
    const vrf = queryVrfKey('1,234.00', keys.secretKey, keys.merchantId, '1234567890', '00')
    const g = fiuu({
      ...keys,
      environment: 'sandbox',
      fetch: async () =>
        new Response(
          JSON.stringify({
            StatCode: '00',
            StatName: 'captured',
            TranID: '1234567890',
            Amount: '1,234.00',
            Domain: keys.merchantId,
            OrderID: 'ORDERX',
            Currency: 'MYR',
            VrfKey: vrf,
          }),
        ),
    })
    const record = await g.getPayment('ORDERX:1234.00:1234567890')
    expect(record.amount).toBeNaN()
    expect(senOf('1,234.00')).toBeNaN()
    expect(senOf('1234.005')).toBeNaN()
    // And the adapter never sends a comma: RM1,234.00 goes out as "1234.00".
    const url = new URL((await gw().createPayment(sampleInput({ amount: 123400 }))).url)
    expect(url.searchParams.get('amount')).toBe('1234.00')
  })

  it('C5: a rate-limited answer (Q99) is one request and a GatewayError, never a retry loop', async () => {
    const input = sampleInput()
    const created = await gw().createPayment(input)
    fake.markPaid(created.id)
    const before = fake.requests.length
    fake.failQueriesWith('Q99')
    try {
      expect(await confirmPayment(gw(), fake.callbackFor(created.id), input)).toMatchObject({
        ok: false,
        reason: 'gateway_error',
      })
      expect(fake.requests.length - before).toBe(1)
    } finally {
      fake.failQueriesWith(null)
    }
    expect(await confirmPayment(gw(), fake.callbackFor(created.id), input)).toMatchObject({ ok: true })
  })

  it('C3/C4/C9/C10: sandbox hosts from SPEC p24, /RMS/ paths, `currency` (not `cur`)', async () => {
    const seen: string[] = []
    const g = fiuu({
      ...keys,
      environment: 'sandbox',
      fetch: async (url) => {
        seen.push(String(url))
        return new Response('Error: Q203 Transaction record not found')
      },
    })
    const url = new URL((await g.createPayment(sampleInput())).url)
    expect(`${url.origin}${url.pathname}`).toBe('https://sandbox-payment.fiuu.com/RMS/pay/SB_fakemerchant/')
    expect(url.searchParams.get('currency')).toBe('MYR')
    expect(url.searchParams.has('cur')).toBe(false)
    await g.getPayment('ORDERX:10.50:1234567890').catch(() => {})
    await g.getPayment('ORDERX:10.50').catch(() => {})
    expect(seen).toEqual([
      'https://sandbox-api.fiuu.com/RMS/q_by_tid.php',
      'https://sandbox-api.fiuu.com/RMS/query/q_by_oid.php',
    ])
  })

  it('`type` is obsoleted for q_by_tid: the default text answer is read as well as JSON', async () => {
    const textFake = await startFakeFiuu({ ...keys, queryOutput: 'text' })
    try {
      const g = fiuu({ ...keys, environment: 'sandbox', baseUrl: textFake.url })
      const input = sampleInput()
      const created = await g.createPayment(input)
      textFake.markPaid(created.id)
      expect(await confirmPayment(g, textFake.callbackFor(created.id), input)).toMatchObject({ ok: true })
    } finally {
      await textFake.close()
    }
    expect(parseQueryAnswer('StatCode: 00\nVrfKey: abc\nErrorCode: ')).toEqual({
      StatCode: '00',
      VrfKey: 'abc',
      ErrorCode: '',
    })
    expect(parseQueryAnswer('{"StatCode":"22","ErrorCode":null}')).toEqual({ StatCode: '22', ErrorCode: '' })
  })

  it('statusOf: success needs captured or settled', () => {
    expect(statusOf('00', 'Captured')).toBe('paid')
    expect(statusOf('00', 'authorized')).toBe('pending')
    expect(statusOf('99', 'captured')).toBe('unknown')
  })
})
