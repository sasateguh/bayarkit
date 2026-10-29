import { describe, expect, it } from 'vitest'
import {
  checkRefundAmount,
  confirmPayment,
  type Gateway,
  GatewayError,
  toRinggit,
  toSen,
  type VerifyResult,
} from '../src/index.js'
import vectors from './money-vectors.json' with { type: 'json' }
import numberText from './number-text-vectors.json' with { type: 'json' }

describe('money vectors shared with the PHP twin', () => {
  it.each(vectors.toSen as [string | number, number | null][])('toSen(%j) → %j', (input, sen) => {
    expect(toSen(input)).toBe(sen ?? Number.NaN)
  })
  it.each(vectors.toRinggit as [number, string][])('toRinggit(%j) → %j', (sen, text) => {
    expect(toRinggit(sen)).toBe(text)
  })
  // The PHP twin's Text::of must write numbers exactly like this; the file is checked against JavaScript itself here.
  it.each(numberText as [number, string][])('String(%j) → %j', (n, text) => {
    expect(String(n)).toBe(text)
  })
})

describe('money', () => {
  it('converts without floating-point drift', () => {
    expect(toRinggit(1050)).toBe('10.50')
    expect(toSen('10.5')).toBe(1050)
    expect(toSen(0.29)).toBe(29)
    expect(toSen('')).toBeNaN()
    expect(toSen(null)).toBeNaN()
    expect(() => toRinggit(10.5)).toThrow(RangeError)
  })
})

describe('confirmPayment', () => {
  const cb = { fields: {}, rawBody: '', headers: {} }
  const gateway = (
    record: Partial<Awaited<ReturnType<Gateway['getPayment']>>>,
    valid = true,
  ): Gateway<VerifyResult> => ({
    info: {
      name: 'stub',
      minimumAmount: 100,
      evidence: { kind: 'docs', date: '2026-10-23', source: 'test' },
    },
    createPayment: async () => ({ id: 'x', url: 'https://x', raw: null }),
    getPayment: async (id) => ({
      id,
      reference: 'R1',
      status: 'paid',
      amount: 500,
      currency: 'MYR',
      raw: null,
      ...record,
    }),
    verifyCallback: () => (valid ? { id: 'x', reference: 'R1', claimedStatus: 'paid', raw: {} } : null),
  })
  const expected = { reference: 'R1', amount: 500 }

  it('needs every check to pass', async () => {
    expect(await confirmPayment(gateway({}), cb, expected)).toMatchObject({ ok: true })
    expect(await confirmPayment(gateway({}, false), cb, expected)).toMatchObject({
      reason: 'invalid_signature',
    })
    expect(await confirmPayment(gateway({ status: 'pending' }), cb, expected)).toMatchObject({
      reason: 'not_paid',
    })
    expect(await confirmPayment(gateway({ amount: 499 }), cb, expected)).toMatchObject({ reason: 'mismatch' })
    expect(await confirmPayment(gateway({ currency: 'SGD' }), cb, expected)).toMatchObject({
      reason: 'mismatch',
    })
    expect(await confirmPayment(gateway({ reference: 'R2' }), cb, expected)).toMatchObject({
      reason: 'mismatch',
    })
  })

  it('reports a gateway outage instead of throwing', async () => {
    const gw = gateway({})
    gw.getPayment = async () => {
      throw new Error('timeout')
    }
    // An unknown error is named, not quoted: its message may carry request details.
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({
      ok: false,
      reason: 'gateway_error',
      detail: 'stub: getPayment threw Error',
    })
    gw.getPayment = async () => {
      throw new GatewayError('unreachable (TimeoutError)', 'stub', 0)
    }
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({
      reason: 'gateway_error',
      detail: 'stub: unreachable (TimeoutError)',
    })
  })

  it('a verifyCallback that throws is a gateway error (a bug or a broken key), not a forgery, and never escapes', async () => {
    const gw = gateway({})
    gw.verifyCallback = () => {
      throw new TypeError('secret=abc in a message')
    }
    const result = await confirmPayment(gw, cb, expected)
    expect(result).toMatchObject({
      ok: false,
      reason: 'gateway_error',
      detail: 'stub: verifyCallback threw TypeError',
    })
  })

  it('awaits a verifyCallback that answers with a Promise (gateways that verify through their API)', async () => {
    const gw = gateway({})
    gw.verifyCallback = async () => ({ id: 'x', reference: 'R1', claimedStatus: 'paid', raw: {} })
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({ ok: true })
    gw.verifyCallback = async () => ({ id: 'x', reference: 'R2', claimedStatus: 'paid', raw: {} })
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('a Promise that resolves to null is a forgery', async () => {
    const gw = gateway({})
    let asked = false
    gw.verifyCallback = async () => null
    gw.getPayment = async () => {
      asked = true
      throw new Error('must not be called')
    }
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({
      ok: false,
      reason: 'invalid_signature',
      detail: 'stub: callback signature did not verify',
    })
    expect(asked).toBe(false)
  })

  it('a Promise that rejects is a gateway error (the verify call failed), not a forgery', async () => {
    const gw = gateway({})
    gw.verifyCallback = async () => {
      throw new TypeError('token=abc in a message')
    }
    expect(await confirmPayment(gw, cb, expected)).toEqual({
      ok: false,
      reason: 'gateway_error',
      detail: 'stub: verifyCallback threw TypeError',
    })
    // A GatewayError quotes the gateway's answer only, so it is passed on (as for getPayment).
    gw.verifyCallback = async () => {
      throw new GatewayError('unreachable (TimeoutError)', 'stub', 0)
    }
    expect(await confirmPayment(gw, cb, expected)).toEqual({
      ok: false,
      reason: 'gateway_error',
      detail: 'stub: unreachable (TimeoutError)',
    })
  })
})

describe('checkRefundAmount (shared by every adapter that refunds)', () => {
  it('accepts a full or partial refund in whole sen', () => {
    expect(() => checkRefundAmount('stub', { paymentId: 'p', amount: 500 }, 500)).not.toThrow()
    expect(() => checkRefundAmount('stub', { paymentId: 'p', amount: 1 }, 500)).not.toThrow()
  })

  it('refuses more than was paid, zero, negative or fractional sen, before any request', () => {
    for (const amount of [501, 0, -1, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => checkRefundAmount('stub', { paymentId: 'p', amount }, 500), String(amount)).toThrow(
        GatewayError,
      )
    }
    try {
      checkRefundAmount('stub', { paymentId: 'p', amount: 501 }, 500)
    } catch (e) {
      expect(e).toMatchObject({ status: 0, message: 'stub: refund of 501 sen exceeds the 500 sen paid' })
    }
  })

  it('refuses an empty payment id', () => {
    expect(() => checkRefundAmount('stub', { paymentId: '', amount: 1 }, 500)).toThrow(GatewayError)
  })
})

describe('readCallback', () => {
  const url = 'https://shop.example/callback'
  it('reads multipart (toyyibPay, measured), url-encoded, JSON and query strings, keeping the raw body', async () => {
    const { readCallback } = await import('../src/index.js')
    const form = new FormData()
    form.set('billcode', 'abc')
    form.set('status', '1')
    const multipart = await readCallback(new Request(url, { method: 'POST', body: form }))
    expect(multipart.fields).toEqual({ billcode: 'abc', status: '1' })
    expect(multipart.rawBody).toContain('name="billcode"')
    const encoded = await readCallback(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Signature': 'sig' },
        body: 'a=1&b=two',
      }),
    )
    expect(encoded).toEqual({
      fields: { a: '1', b: 'two' },
      rawBody: 'a=1&b=two',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-signature': 'sig' },
    })
    const raw = JSON.stringify({ amount: 25, ok: true, nested: { x: 1 } })
    const json = await readCallback(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }),
    )
    expect(json.fields).toEqual({ amount: '25', ok: 'true' })
    expect(json.rawBody).toBe(raw)
    expect((await readCallback(new Request(`${url}?status_id=1&billcode=x`))).fields).toEqual({
      status_id: '1',
      billcode: 'x',
    })
  })

  it('gives empty fields for a broken body instead of throwing', async () => {
    const { readCallback } = await import('../src/index.js')
    const bad = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect((await readCallback(bad)).fields).toEqual({})
  })
})
