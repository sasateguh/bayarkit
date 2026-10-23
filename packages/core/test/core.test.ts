import { describe, expect, it } from 'vitest'
import { confirmPayment, type Gateway, toRinggit, toSen } from '../src/index.js'

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
  const gateway = (record: Partial<Awaited<ReturnType<Gateway['getPayment']>>>, valid = true): Gateway => ({
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
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({
      ok: false,
      reason: 'gateway_error',
      detail: 'timeout',
    })
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
