import { createHash } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError, readCallback } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeGkash } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import { gkash, gkashSignature, signingAmount, statusOf } from '../src/index.js'

const keys = { cid: 'M161-U-999', signatureKey: 'fake-signature-key' }

gatewayConformance('gkash', async () => {
  const fake = await startFakeGkash(keys)
  return { fake, gateway: gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

// Official examples, doc.gkash.my (spec §4.4). The key is the published sample key, not a secret.
const DOC_KEY = 'SIGNATUREKEY9999' // gitleaks:allow — sample key from doc.gkash.my
const DOC_CID = 'M161-U-999'
const DOC_CART = 'MERCHANT-REFERENCE-712893'
const DOC_POID = 'M161-PO-999999'
const V_REQUEST =
  '52d08ae99588d9ac00dbd59ae1ec6d3bf44657feeebaa4758517aa79aa6e791315a82055c5e498c780e2f977575c755d5623cd5ad198d780cde2742a7b92041c'
const V_CALLBACK =
  '7a93e3420fef64dc7ac439cde5bcb8f6daaeff4336e1cc533dc70da64056a369a88ed3550d7b344a2feba0666413a676ec00fb4a93647f9dd207fe1e56e83fce'
const V_PENDING =
  '13498ca0cc98d8ff25326f90085808ace44e48e43c5b42010ab92f95f0fddd077b15a7e90344ee26f7dd57c41fd70b3e7b8b4a955d477464d5f035eca6b4d7a4'
const V_REFUND =
  '8e7265cda1a7d756bd155dba27cb91cda579a3b2ac54ea1edf0bf2ecbf9b0a4b929a9667f9bce2aa54b43a761313d6b68561a9d1ae5207274704aa6e45d6e89f'

/** The DOC callback (spec §5) with the CID the published signature was computed for. */
const DOC_CALLBACK = {
  CID: DOC_CID,
  POID: DOC_POID,
  status: '88 - Transferred',
  cartid: DOC_CART,
  currency: 'MYR',
  amount: '100.00',
  signature: V_CALLBACK,
}

const docGateway = (cid = DOC_CID) => gkash({ cid, signatureKey: DOC_KEY, environment: 'sandbox' })
const form = (fields: Record<string, string>): CallbackInput => ({
  fields,
  rawBody: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

/** Terminal / Soundbox convention (spec §4.3, C5): input NOT upper-cased, hex output upper-cased. */
const terminalHash = (s: string) => createHash('sha512').update(s).digest('hex').toUpperCase()

describe('gkash: every official test vector (spec §4.4)', () => {
  it('create / query request', () => {
    expect(gkashSignature(DOC_KEY, [DOC_CID, DOC_CART, '10000', 'MYR'])).toBe(V_REQUEST)
  })

  it('callback / return (success), via the helper and via verifyCallback', () => {
    expect(gkashSignature(DOC_KEY, [DOC_CID, DOC_POID, DOC_CART, '10000', 'MYR', '88 - Transferred'])).toBe(
      V_CALLBACK,
    )
    expect(docGateway().verifyCallback(form(DOC_CALLBACK))).toEqual({
      id: `${DOC_CART}:10000`,
      reference: DOC_CART,
      claimedStatus: 'paid',
      raw: DOC_CALLBACK,
    })
  })

  it('checkout response / pending', () => {
    expect(gkashSignature(DOC_KEY, [DOC_CID, DOC_POID, DOC_CART, '10000', 'MYR', '11 - Pending'])).toBe(
      V_PENDING,
    )
    const cb = docGateway().verifyCallback(
      form({ ...DOC_CALLBACK, status: '11 - Pending', signature: V_PENDING }),
    )
    expect(cb?.claimedStatus).toBe('pending')
  })

  it('refund request (cart …712894)', () => {
    expect(gkashSignature(DOC_KEY, [DOC_CID, 'MERCHANT-REFERENCE-712894', '10000', 'MYR'])).toBe(V_REFUND)
  })

  it('pre-auth and capture (DOC prints only the full value; the spec records the prefix)', () => {
    expect(gkashSignature(DOC_KEY, [DOC_CID, DOC_CART, '10000', 'MYR', 'PREAUTH'])).toMatch(
      /^d214ad338b9c461b/,
    )
    expect(gkashSignature(DOC_KEY, [DOC_CID, 'MERCHANT-REFERENCE-712894', '10000', 'MYR', DOC_POID])).toMatch(
      /^93d99585989aa406/,
    )
  })

  it('terminal RemotePay and cancel use the OTHER convention (C5), which the online helper does not produce', () => {
    const remote = `${DOC_KEY};10000;MYR;merchant-reference-712894;M161-TD-999`
    expect(terminalHash(remote)).toMatch(/^03F4F4380B8E3B78/)
    expect(terminalHash(`${DOC_KEY};M161-TD-999`)).toMatch(/^ED17C82CE5432A6A/)
    expect(gkashSignature(DOC_KEY, ['10000', 'MYR', 'merchant-reference-712894', 'M161-TD-999'])).not.toMatch(
      /^03f4f4380b8e3b78/,
    )
  })
})

describe('gkash: signing amount (AMT)', () => {
  it('keeps two decimals and the leading zero: 0.10 → "010", never integer sen "10"', () => {
    expect(signingAmount('0.10')).toBe('010')
    expect(signingAmount('100.00')).toBe('10000')
    expect(signingAmount('1')).toBe('100')
    expect(signingAmount('1,000.00')).toBe('100000')
    for (const bad of ['', '1.005', '-1.00', '1e3', ' 1.00', 'abc']) expect(signingAmount(bad)).toBeNull()
  })

  it('a callback for RM0.10 verifies only when signed with "010"', () => {
    const fields = { ...DOC_CALLBACK, amount: '0.10' }
    const good = gkashSignature(DOC_KEY, [DOC_CID, DOC_POID, DOC_CART, '010', 'MYR', '88 - Transferred'])
    const sen = gkashSignature(DOC_KEY, [DOC_CID, DOC_POID, DOC_CART, '10', 'MYR', '88 - Transferred'])
    expect(docGateway().verifyCallback(form({ ...fields, signature: good }))?.id).toBe(`${DOC_CART}:10`)
    expect(docGateway().verifyCallback(form({ ...fields, signature: sen }))).toBeNull()
  })

  it('sends the request signature over "010"-style AMT for amounts under RM1 too (1.05 → "105")', async () => {
    const fake = await startFakeGkash(keys)
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    await gw.createPayment(sampleInput({ amount: 105 }))
    expect(fake.requests.at(-1)?.body).toMatchObject({
      v_amount: '1.05',
      signature: gkashSignature(keys.signatureKey, [
        keys.cid,
        String(fake.requests.at(-1)?.body.v_cartid),
        '105',
        'MYR',
      ]),
    })
    await fake.close()
  })
})

describe('gkash: contradictions in the official material (spec §9)', () => {
  it("C6: DOC's own callback cURL example (CID=M161-U-99) fails its own signature and is refused", () => {
    const asPublished = { ...DOC_CALLBACK, CID: 'M161-U-99' }
    expect(docGateway().verifyCallback(form(asPublished))).toBeNull()
    // Even a merchant whose CID really is M161-U-99 cannot accept it: the signature was made for M161-U-999.
    expect(docGateway('M161-U-99').verifyCallback(form(asPublished))).toBeNull()
  })

  it("C1: sends version 1.5.0 like the official plugin and SDKs; DOC's 1.5.5 only when configured", async () => {
    const fake = await startFakeGkash(keys)
    await gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url }).createPayment(sampleInput())
    expect(fake.requests.at(-1)?.body).toMatchObject({ version: '1.5.0' })
    await gkash({ ...keys, version: '1.5.5', environment: 'sandbox', baseUrl: fake.url }).createPayment(
      sampleInput(),
    )
    expect(fake.requests.at(-1)?.body).toMatchObject({ version: '1.5.5' })
    await fake.close()
  })

  it('C2: the return verifies the same whether POSTed (DOC) or read from the URL query (SDKs, "+" for spaces)', async () => {
    const posted = await readCallback(
      new Request('https://shop.example/return', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(DOC_CALLBACK).toString(),
      }),
    )
    const query = `CID=${DOC_CID}&POID=${DOC_POID}&status=88+-+Transferred&cartid=${DOC_CART}&currency=MYR&amount=100.00&signature=${V_CALLBACK}`
    const viaGet = await readCallback(new Request(`https://shop.example/return?${query}`))
    for (const cb of [posted, viaGet]) expect(docGateway().verifyCallback(cb)?.claimedStatus).toBe('paid')
  })

  it('C3: amounts posted without two decimals are normalised like DOC says, more decimals are refused', () => {
    for (const amount of ['100', '100.0', '100.00'])
      expect(docGateway().verifyCallback(form({ ...DOC_CALLBACK, amount }))?.id).toBe(`${DOC_CART}:10000`)
    expect(docGateway().verifyCallback(form({ ...DOC_CALLBACK, amount: '100.000' }))).toBeNull()
  })

  it('C5: a callback signed with the terminal convention (no upper-casing, upper-case hex) is refused', () => {
    const terminal = terminalHash(`${DOC_KEY};${DOC_CID};${DOC_POID};${DOC_CART};10000;MYR;88 - Transferred`)
    expect(docGateway().verifyCallback(form({ ...DOC_CALLBACK, signature: terminal }))).toBeNull()
    // …while an upper-cased hex of the RIGHT signature is accepted (the plugin lowercases what it receives).
    expect(
      docGateway().verifyCallback(form({ ...DOC_CALLBACK, signature: V_CALLBACK.toUpperCase() })),
    ).not.toBeNull()
  })

  it('C8: the checkout response is verified with the callback formula and 11 - PENDING', async () => {
    const answer = {
      status: '11 - Pending',
      cid: DOC_CID,
      poId: DOC_POID,
      cartId: DOC_CART,
      amount: '100.00',
      currency: 'MYR',
      signature: V_PENDING,
      redirect: { url: 'https://api-staging.pay.asia/pay/abc' },
    }
    let sent: Record<string, string> = {}
    const gw = (body: unknown) =>
      gkash({
        cid: DOC_CID,
        signatureKey: DOC_KEY,
        environment: 'sandbox',
        fetch: async (_url, init) => {
          sent = JSON.parse(String(init?.body))
          return Response.json(body)
        },
      })
    const input = sampleInput({ reference: DOC_CART, amount: 10000 })
    const created = await gw(answer).createPayment(input)
    expect(sent).toMatchObject({ version: '1.5.0', CID: DOC_CID, v_cartid: DOC_CART, v_amount: '100.00' })
    expect(sent.signature).toBe(V_REQUEST)
    expect(created).toMatchObject({ id: `${DOC_CART}:10000`, url: answer.redirect.url })
    for (const bad of [
      { ...answer, signature: V_CALLBACK },
      { ...answer, amount: '1.00' },
      { ...answer, cartId: 'MERCHANT-REFERENCE-712894' },
    ]) {
      await expect(gw(bad).createPayment(input)).rejects.toMatchObject({ code: 'RESPONSE_SIGNATURE' })
    }
    const { url: _u, ...htmlOnly } = { ...answer.redirect, html: '<form></form>' }
    await expect(gw({ ...answer, redirect: htmlOnly }).createPayment(input)).rejects.toMatchObject({
      code: 'REDIRECT_HTML',
    })
  })
})

describe('gkash: query and status', () => {
  it('only 88 is paid; 66 failed, 11 pending, anything else unknown', () => {
    expect(statusOf('88 - Transferred')).toBe('paid')
    expect(statusOf(' 88 - TRANSFERRED')).toBe('paid')
    expect(statusOf('66 - Failed')).toBe('failed')
    expect(statusOf('11 - Pending')).toBe('pending')
    for (const s of ['00 - Approved', '880 - X', '', 'Transferred', undefined])
      expect(statusOf(s)).toBe('unknown')
  })

  it('reads failed and pending from the gateway, and a failed payment never confirms', async () => {
    const fake = await startFakeGkash(keys)
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput()
    const created = await gw.createPayment(input)
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    fake.setStatus(created.id, '66 - Failed')
    expect(await gw.getPayment(created.id)).toMatchObject({
      status: 'failed',
      reference: input.reference,
      amount: input.amount,
      currency: 'MYR',
      fee: null,
    })
    expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
    // A callback that itself says failed still verifies (it is a signed claim), and claims failed.
    expect(gw.verifyCallback(fake.callbackFor(created.id, { status: '66 - Failed' }))?.claimedStatus).toBe(
      'failed',
    )
    await fake.close()
  })

  it('queries by cart id with the amount from the id, version 1.3.0, signed like a request', async () => {
    const fake = await startFakeGkash(keys)
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput({ amount: 2500 })
    const created = await gw.createPayment(input)
    expect(created.id).toBe(`${input.reference}:2500`)
    await gw.getPayment(created.id)
    expect(fake.requests.at(-1)).toMatchObject({
      path: '/api/payment/query',
      body: {
        version: '1.3.0',
        CID: keys.cid,
        cartid: input.reference,
        currency: 'MYR',
        amount: '25.00',
        signature: gkashSignature(keys.signatureKey, [keys.cid, input.reference, '2500', 'MYR']),
      },
    })
    await fake.close()
  })

  const queryWith = (answer: Record<string, unknown>) =>
    gkash({
      ...keys,
      environment: 'sandbox',
      fetch: async () => Response.json(answer),
    }).getPayment('ORDER1:1050')

  it('refuses an unsigned query answer that is about another cart id or merchant', async () => {
    const ok = {
      CID: keys.cid,
      POID: 'P1',
      status: '88 - Transferred',
      cartid: 'ORDER1',
      currency: 'MYR',
      amount: '10.50',
    }
    expect((await queryWith(ok)).status).toBe('paid')
    await expect(queryWith({ ...ok, cartid: 'ORDER2' })).rejects.toMatchObject({ code: 'QUERY_MISMATCH' })
    await expect(queryWith({ ...ok, CID: 'M161-U-1' })).rejects.toMatchObject({ code: 'QUERY_MISMATCH' })
  })

  it('a refunded payment is never paid, and an unreadable amount is NaN, not rounded', async () => {
    const ok = {
      CID: keys.cid,
      status: '88 - Transferred',
      cartid: 'ORDER1',
      currency: 'MYR',
      amount: '10.50',
    }
    expect((await queryWith({ ...ok, refundamount: '10.50' })).status).toBe('unknown')
    expect((await queryWith({ ...ok, refundamount: '0.00' })).status).toBe('paid')
    expect((await queryWith({ ...ok, amount: '10.505' })).amount).toBeNaN()
  })

  it('refuses ids that are not <cartid>:<sen>', async () => {
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    for (const id of ['ORDER1', 'ORDER1:10.50', '../x:1', ':1'])
      await expect(gw.getPayment(id)).rejects.toMatchObject({ code: 'INVALID_ID' })
  })
})

describe('gkash: create payment', () => {
  it('sends ringgit with two decimals, the reference as v_cartid, both URLs and buyer data', async () => {
    const fake = await startFakeGkash(keys)
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput({ amount: 1050 })
    await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.contentType).toBe('application/json')
    expect(sent?.body).toMatchObject({
      CID: keys.cid,
      v_cartid: input.reference,
      v_currency: 'MYR',
      v_amount: '10.50',
      returnurl: input.returnUrl,
      callbackurl: input.callbackUrl,
      v_firstname: 'Ali bin Abu',
      v_billemail: 'ali@example.com',
      v_productdesc: input.description,
    })
    await fake.close()
  })

  it('refuses references Gkash does not allow instead of rewriting them', async () => {
    const gw = gkash({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    for (const reference of ['ORDER 1', 'ORDER#1', 'ORDER:1', ''])
      await expect(gw.createPayment(sampleInput({ reference }))).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      })
  })

  it('a wrong signature key is a GatewayError that does not leak the key', async () => {
    const wrongKey = `${keys.signatureKey}-wrong`
    const fake = await startFakeGkash(keys)
    const gw = gkash({ ...keys, signatureKey: wrongKey, environment: 'sandbox', baseUrl: fake.url })
    const err = await gw.createPayment(sampleInput()).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.status).toBe(400)
    expect(err.message).not.toContain(wrongKey)
    await fake.close()
  })

  it('uses the production host the official plugin and SDKs use', async () => {
    let seen = ''
    await gkash({
      ...keys,
      environment: 'production',
      fetch: async (url) => {
        seen = String(url)
        return Response.json({})
      },
    })
      .createPayment(sampleInput())
      .catch(() => {})
    expect(seen).toBe('https://api.gkash.my/api/payment/form')
  })
})

describe('gkash: callbacks', () => {
  it('refuses a callback for another merchant, another currency, or with a missing field', () => {
    const gw = docGateway()
    const resign = (f: Record<string, string>) => ({
      ...f,
      signature: gkashSignature(DOC_KEY, [
        f.CID ?? '',
        f.POID ?? '',
        f.cartid ?? '',
        '10000',
        f.currency ?? '',
        f.status ?? '',
      ]),
    })
    expect(gw.verifyCallback(form(resign({ ...DOC_CALLBACK, CID: 'M161-U-1' })))).toBeNull()
    expect(gw.verifyCallback(form(resign({ ...DOC_CALLBACK, currency: 'SGD' })))).toBeNull()
    expect(gw.verifyCallback(form(resign({ ...DOC_CALLBACK, POID: '' })))).toBeNull()
  })

  it('every signed field counts: changing one breaks the official signature', () => {
    for (const change of [
      { amount: '1.00' },
      { status: '66 - Failed' },
      { cartid: 'MERCHANT-REFERENCE-712894' },
      { POID: 'M161-PO-1' },
    ])
      expect(docGateway().verifyCallback(form({ ...DOC_CALLBACK, ...change }))).toBeNull()
  })

  it('fields outside the signature (description, PaymentType) are kept in raw but decide nothing', () => {
    const cb = docGateway().verifyCallback(
      form({ ...DOC_CALLBACK, description: '00 - Approved', PaymentType: 'x' }),
    )
    expect(cb?.raw.description).toBe('00 - Approved')
  })
})
