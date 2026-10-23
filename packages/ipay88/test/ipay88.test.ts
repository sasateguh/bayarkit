import { createHash, createHmac } from 'node:crypto'
import { confirmPayment, GatewayError, readCallback } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeIPay88 } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import {
  amountForSignature,
  BACKEND_ACK,
  backendAck,
  hmacSha512,
  ipay88,
  parsePaymentId,
  requestSignature,
  requestSigningString,
  responseSignature,
  responseSigningString,
  senOf,
} from '../src/index.js'

const keys = { merchantCode: 'M00099', merchantKey: 'fake-merchant-key' }

gatewayConformance('ipay88', async () => {
  const fake = await startFakeIPay88(keys)
  return { fake, gateway: ipay88({ ...keys, environment: 'production', baseUrl: fake.url }) }
})

// Official vectors (gateways/ipay88/spec.md §4): key `apple`, reproduced with the gateway's own hmac-sha512.js; the
// HMAC values also appear in the SPEC. `apple` is the published sample MerchantKey, not a secret.
const DOC = {
  merchantKey: 'apple',
  merchantCode: 'M00003',
  refNo: 'A00000001',
  amount: '1.00',
  currency: 'MYR',
}
const V1 =
  'c41859fed9b4ac135990cc10737ff3a37ad1e0eaa3e0f2235a652172fe3465413449b2e73acb782bb14a1b2e32792e91dc03fd2da355432de86df6730ed70e9a' // gitleaks:allow official HMAC test vector
const V2 =
  'd8e0b9807bdd10527267f6433f9487155f56d42fdd23d3d76f2315bf72fdb50806e81e5a42491c64eb368c9e9165364fa3b011dcc81963b2fd465cfcdae77288' // gitleaks:allow official HMAC test vector
const V3 =
  '2b8bcaf66881a9f02a7a2b470cbdf958a86d92f2169774de1062db0376545b061c98f78827db0dbe8aacf908982d5777f577370e19658649a9794c7168b5a5d7' // gitleaks:allow official HMAC test vector
const L1 = '110f0be755ccfa9373aa38104bafbc5c6e5462344e44bcfbb70439c82b4b07fa' // gitleaks:allow official SHA-256 tool output
const L2 = 'f173a2521d178574caab19ab7ddd04b299dbc0d656a26c1d1aabf9187dfbf352' // gitleaks:allow official SHA-256 tool output
const L3 = '84dNMbfgjLMS42IqSTPqQ99cUGA=' // gitleaks:allow official SHA-1 tool output

const docGateway = () =>
  ipay88({
    merchantCode: 'M00003',
    merchantKey: 'apple',
    environment: 'production',
    baseUrl: 'http://127.0.0.1:9',
  })

const docCallback = (over: Record<string, string> = {}) => ({
  fields: {
    MerchantCode: 'M00003',
    PaymentId: '2',
    RefNo: 'A00000001',
    Amount: '1.00',
    Currency: 'MYR',
    Remark: '',
    TransId: 'T0000000001',
    AuthCode: '',
    Status: '1',
    ErrDesc: '',
    Signature: V3,
    ...over,
  },
  rawBody: '',
  headers: {},
})

/** A gateway that answers enquiry.asp with `body`, recording what it was sent. */
const answering = (body: string, status = 200) => {
  const sent: { url: string; body: string }[] = []
  const gateway = ipay88({
    ...keys,
    environment: 'production',
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: String(init.body ?? '') })
      return new Response(body, { status, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch,
  })
  return { gateway, sent }
}

describe('ipay88: official test vectors', () => {
  it('V1 request (HMAC-SHA512, key also leads the message, amount 1.00 → 100)', () => {
    expect(requestSigningString(DOC)).toBe('appleM00003A00000001100MYR')
    expect(requestSignature(DOC)).toBe(V1)
  })

  it('V1 is the Signature the adapter puts in its form', async () => {
    const created = await docGateway().createPayment(
      sampleInput({ reference: 'A00000001', amount: 100, customer: { name: 'Ali', email: 'a@example.com' } }),
    )
    expect(created.form.fields).toMatchObject({
      MerchantCode: 'M00003',
      RefNo: 'A00000001',
      Amount: '1.00',
      Currency: 'MYR',
      SignatureType: 'HMACSHA512',
      Signature: V1,
    })
    expect(created.id).toBe('A00000001:100')
    expect(created.url).toBe('http://127.0.0.1:9/entry.asp')
    expect(created.form.method).toBe('POST')
  })

  it('V2 request with Xfield1 xx11 (the SPEC reading)', () => {
    expect(requestSigningString({ ...DOC, xfield1: 'xx11' })).toBe('appleM00003A00000001100MYRxx11')
    expect(requestSignature({ ...DOC, xfield1: 'xx11' })).toBe(V2)
  })

  it('V3 response (PaymentId 2, Status 1) and the adapter accepts that callback', () => {
    const p = { ...DOC, paymentId: '2', status: '1' }
    expect(responseSigningString(p)).toBe('appleM000032A00000001100MYR1')
    expect(responseSignature(p)).toBe(V3)
    expect(docGateway().verifyCallback(docCallback())).toMatchObject({
      id: 'A00000001:100',
      reference: 'A00000001',
      claimedStatus: 'paid',
    })
    // Hex case does not matter.
    expect(docGateway().verifyCallback(docCallback({ Signature: V3.toUpperCase() }))).not.toBeNull()
  })

  it('legacy L1–L3 (official SHA-256 / SHA-1 tools) are reproduced, and callbacks signed that way are refused', () => {
    expect(createHash('sha256').update('appleM00003A00000001100MYR').digest('hex')).toBe(L1)
    expect(createHash('sha256').update('appleM000032A00000001100MYR1').digest('hex')).toBe(L2)
    expect(createHash('sha1').update('appleM00003A00000001100MYR').digest('base64')).toBe(L3)
    const gw = docGateway()
    expect(gw.verifyCallback(docCallback({ Signature: L2 }))).toBeNull()
    expect(gw.verifyCallback(docCallback({ Signature: L3 }))).toBeNull()
  })

  it('the trap the spec warns about: an HMAC over the fields WITHOUT the key in front is refused', () => {
    const normal = createHmac('sha512', 'apple').update('M000032A00000001100MYR1').digest('hex')
    expect(normal).not.toBe(V3)
    expect(docGateway().verifyCallback(docCallback({ Signature: normal }))).toBeNull()
    // …and a plain SHA-512 of the right string (no HMAC) too.
    const plain = createHash('sha512').update('appleM000032A00000001100MYR1').digest('hex')
    expect(docGateway().verifyCallback(docCallback({ Signature: plain }))).toBeNull()
  })

  it('every signed value counts', () => {
    const gw = docGateway()
    for (const over of [{ Amount: '2.00' }, { RefNo: 'A00000002' }, { PaymentId: '6' }, { Status: '0' }]) {
      expect(gw.verifyCallback(docCallback(over))).toBeNull()
    }
  })
})

describe('ipay88: contradictions in the spec (§8)', () => {
  it('C1 Xfield1: always sent empty, so the SPEC and the official tool agree on the request signature', async () => {
    const created = await docGateway().createPayment(
      sampleInput({ reference: 'A00000001', amount: 100, customer: { name: 'Ali', email: 'a@example.com' } }),
    )
    expect(created.form.fields.Xfield1).toBe('')
    expect(requestSignature({ ...DOC, xfield1: '' })).toBe(requestSignature(DOC))
    expect(created.form.fields.Signature).not.toBe(V2)
  })

  it('C2 amount stripping: every "." and "," is removed (the official tool removes only the first of each)', () => {
    const tool = (a: string) => a.replace('.', '').replace(',', '')
    expect(tool('1,000,000.00')).toBe('1000,00000')
    expect(amountForSignature('1,000,000.00')).toBe('100000000')
    expect(amountForSignature('1,278.99')).toBe('127899')
    expect(senOf('1,000,000.00')).toBe(100_000_000)
    expect(senOf('1,278.99')).toBe(127_899)
    for (const bad of ['1.0', '1,00.00', '12', '1.000', '-1.00', '', '1e3.00']) expect(senOf(bad)).toBeNaN()

    const key = 'apple'
    const sign = (amountText: string) => hmacSha512(key, `${key}M000032BIG1${amountText}MYR1`)
    const fields = { ...docCallback().fields, RefNo: 'BIG1', Amount: '1,000,000.00' }
    const gw = docGateway()
    // Full strip (this adapter's reading) verifies…
    expect(
      gw.verifyCallback({ fields: { ...fields, Signature: sign('100000000') }, rawBody: '', headers: {} }),
    ).toMatchObject({
      id: 'BIG1:100000000',
    })
    // …a callback signed the tool's way is refused (fail closed), never accepted.
    expect(
      gw.verifyCallback({ fields: { ...fields, Signature: sign('1000,00000') }, rawBody: '', headers: {} }),
    ).toBeNull()
  })

  it('C2: the adapter never sends a thousands separator, so its own requests sign the same under both readings', async () => {
    const created = await docGateway().createPayment(
      sampleInput({
        reference: 'BIG2',
        amount: 100_000_000,
        customer: { name: 'Ali', email: 'a@example.com' },
      }),
    )
    expect(created.form.fields.Amount).toBe('1000000.00')
    const tool = (a: string) => a.replace('.', '').replace(',', '')
    expect(tool(created.form.fields.Amount ?? '')).toBe(amountForSignature(created.form.fields.Amount ?? ''))
  })

  it('C3 algorithm: only HMACSHA512 is sent; a 64-hex SHA-256 signature of the right string is refused', () => {
    const sha256 = createHash('sha256').update('appleM000032A00000001100MYR1').digest('hex')
    expect(docGateway().verifyCallback(docCallback({ Signature: sha256 }))).toBeNull()
  })

  it('C4–C6: re-query is enquiry.asp with RefNo (not the SOAP ReferenceNo), answers parsed as bare text', async () => {
    const { gateway, sent } = answering('00')
    const record = await gateway.getPayment('ORD-1:1050')
    expect(sent[0]?.url).toBe('https://payment.ipay88.com.my/epayment/enquiry.asp')
    expect(Object.fromEntries(new URLSearchParams(sent[0]?.body))).toEqual({
      MerchantCode: 'M00099',
      RefNo: 'ORD-1',
      Amount: '10.50',
    })
    expect(record).toMatchObject({
      id: 'ORD-1:1050',
      reference: 'ORD-1',
      amount: 1050,
      currency: 'MYR',
      status: 'paid',
    })
    expect(record.paidAt).toBeUndefined()
    expect(record.fee).toBeNull()
  })

  it('C7 iPay88 Indonesia signing (plain SHA-256 with || separators) is refused', () => {
    const indo = createHash('sha256').update('||apple||M00003||A00000001||100||MYR||').digest('hex')
    expect(docGateway().verifyCallback(docCallback({ Signature: indo }))).toBeNull()
  })
})

describe('ipay88: enquiry.asp answers', () => {
  it.each([
    ['00', 'paid'],
    ['  00\r\n', 'paid'],
    ['Payment fail', 'failed'],
    ['M88Admin', 'failed'],
    ['Record not found', 'pending'],
    ['Incorrect amount', 'unknown'],
    ['0', 'unknown'],
    ['000', 'unknown'],
    ['<html>00</html>', 'unknown'],
    ['', 'unknown'],
  ])('%j → %s (only the exact text 00 is paid)', async (body, status) => {
    const { gateway } = answering(body)
    expect((await gateway.getPayment('R1:100')).status).toBe(status)
  })

  it('Invalid parameters and HTTP errors throw GatewayError quoting the reply, never the key', async () => {
    const invalid = answering('Invalid parameters').gateway.getPayment('R1:100')
    await expect(invalid).rejects.toBeInstanceOf(GatewayError)
    await expect(invalid).rejects.toThrow(/Invalid parameters/)
    const down = answering('Service Unavailable', 503).gateway.getPayment('R1:100')
    await expect(down).rejects.toThrow(/HTTP 503: Service Unavailable/)
    await down.catch((e: Error) => expect(e.message).not.toContain(keys.merchantKey))
  })

  it('refuses ids that are not <RefNo>:<sen> before calling iPay88', async () => {
    const { gateway, sent } = answering('00')
    for (const id of ['', 'R1', ':100', 'R1:', 'R1:1.00', 'R1:-1', 'a b:100']) {
      await expect(gateway.getPayment(id)).rejects.toBeInstanceOf(GatewayError)
    }
    expect(sent).toHaveLength(0)
    expect(parsePaymentId('A:B:100')).toEqual({ refNo: 'A:B', amount: 100 })
  })
})

describe('ipay88: callbacks', () => {
  it('a real form POST read with readCallback verifies (iPay88 signs values, not bytes)', async () => {
    const fake = await startFakeIPay88(keys)
    const gateway = ipay88({ ...keys, environment: 'production', baseUrl: fake.url })
    const input = sampleInput({ amount: 127_899 })
    const created = await gateway.createPayment(input)
    fake.markPaid(created.id)
    const cb = fake.callbackFor(created.id)
    expect(cb.fields.Amount).toBe('1,278.99')
    const request = new Request('https://shop.example/callback', {
      method: 'POST',
      headers: cb.headers,
      body: cb.rawBody,
    })
    const result = await confirmPayment(gateway, await readCallback(request), input)
    expect(result).toMatchObject({ ok: true, payment: { amount: 127_899, reference: input.reference } })
    await fake.close()
  })

  it('refuses a missing signature, another merchant, a non-MYR currency, an unreadable amount', () => {
    const gw = docGateway()
    expect(gw.verifyCallback(docCallback({ Signature: '' }))).toBeNull()
    const signed = (over: Record<string, string>) => {
      const f = { ...docCallback().fields, ...over }
      return docCallback({
        ...over,
        Signature: responseSignature({
          merchantKey: 'apple',
          merchantCode: f.MerchantCode,
          paymentId: f.PaymentId,
          refNo: f.RefNo,
          amount: f.Amount,
          currency: f.Currency,
          status: f.Status,
        }),
      })
    }
    expect(gw.verifyCallback(signed({}))).not.toBeNull()
    expect(gw.verifyCallback(signed({ MerchantCode: 'M00004' }))).toBeNull()
    expect(gw.verifyCallback(signed({ Currency: 'USD' }))).toBeNull()
    expect(gw.verifyCallback(signed({ Amount: '1.0' }))).toBeNull()
    expect(gw.verifyCallback(signed({ Status: '0' }))).toMatchObject({ claimedStatus: 'failed' })
    expect(gw.verifyCallback(signed({ Status: '6' }))).toMatchObject({ claimedStatus: 'pending' })
    expect(gw.verifyCallback(signed({ Status: '20' }))).toMatchObject({ claimedStatus: 'unknown' })
  })

  it('a correctly signed success callback for a failed payment does not confirm', async () => {
    const fake = await startFakeIPay88(keys)
    const gateway = ipay88({ ...keys, environment: 'production', baseUrl: fake.url })
    const input = sampleInput()
    const created = await gateway.createPayment(input)
    fake.markFailed(created.id)
    expect(await confirmPayment(gateway, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
      detail: 'gateway reports failed',
    })
    await fake.close()
  })

  it('the backend page answers exactly RECEIVEOK', async () => {
    expect(BACKEND_ACK).toBe('RECEIVEOK')
    expect(await backendAck().text()).toBe('RECEIVEOK')
  })
})

describe('ipay88: the payment form', () => {
  it('posts to entry.asp, and the fake (built from the spec) accepts it', async () => {
    const fake = await startFakeIPay88(keys)
    const gateway = ipay88({ ...keys, environment: 'production', baseUrl: fake.url })
    const input = sampleInput()
    const created = await gateway.createPayment(input)
    const res = await fetch(created.form.action, {
      method: created.form.method,
      body: new URLSearchParams(created.form.fields),
    })
    expect(await res.text()).toContain(`payment page for ${input.reference}`)
    expect((await gateway.getPayment(created.id)).status).toBe('failed') // fake: existing unpaid record = Payment fail
    fake.markPaid(created.id)
    expect((await gateway.getPayment(created.id)).status).toBe('paid')
    const again = await fetch(created.form.action, {
      method: 'POST',
      body: new URLSearchParams(created.form.fields),
    })
    expect(await again.text()).toBe('Duplicate reference number')
    const forged = await fetch(created.form.action, {
      method: 'POST',
      body: new URLSearchParams({ ...created.form.fields, Amount: '0.01' }),
    })
    expect(await forged.text()).toBe('Signature not match')
    await fake.close()
  })

  it('every mandatory and optional parameter exists; the key is never in the form or the page', async () => {
    const created = await docGateway().createPayment(
      sampleInput({ reference: 'R-1', description: 'Kopi "O" <ais>' }),
    )
    expect(Object.keys(created.form.fields).sort()).toEqual(
      [
        'Amount',
        'Appdeeplink',
        'BackendURL',
        'Currency',
        'Lang',
        'MerchantCode',
        'Optional',
        'PaymentId',
        'ProdDesc',
        'RefNo',
        'Remark',
        'ResponseURL',
        'Signature',
        'SignatureType',
        'UserContact',
        'UserEmail',
        'UserName',
        'Xfield1',
      ].sort(),
    )
    expect(created.form.fields.Lang).toBe('UTF-8')
    expect(created.form.fields.UserContact).toBe('0123456789')
    expect(created.html).toContain('value="Kopi &quot;O&quot; &lt;ais&gt;"')
    expect(created.html).not.toContain('<ais>')
    expect(JSON.stringify(created)).not.toContain('"apple')
  })

  it('refuses what iPay88 would refuse, before anything is sent', async () => {
    const gw = docGateway()
    const bad = [
      sampleInput({ reference: 'x'.repeat(31) }),
      sampleInput({ reference: 'has space' }),
      sampleInput({ reference: 'a:b' }),
      sampleInput({ currency: 'USD' as 'MYR' }),
      sampleInput({ customer: { name: 'Ali' } }),
      sampleInput({ customer: { email: 'a@example.com' } }),
      sampleInput({ callbackUrl: `https://shop.example/${'x'.repeat(200)}` }),
    ]
    for (const input of bad) await expect(gw.createPayment(input)).rejects.toBeInstanceOf(GatewayError)
  })
})
