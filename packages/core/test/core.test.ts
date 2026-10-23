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
    expect(await confirmPayment(gateway({}), {}, expected)).toMatchObject({ ok: true })
    expect(await confirmPayment(gateway({}, false), {}, expected)).toMatchObject({
      reason: 'invalid_signature',
    })
    expect(await confirmPayment(gateway({ status: 'pending' }), {}, expected)).toMatchObject({
      reason: 'not_paid',
    })
    expect(await confirmPayment(gateway({ amount: 499 }), {}, expected)).toMatchObject({ reason: 'mismatch' })
    expect(await confirmPayment(gateway({ currency: 'SGD' }), {}, expected)).toMatchObject({
      reason: 'mismatch',
    })
    expect(await confirmPayment(gateway({ reference: 'R2' }), {}, expected)).toMatchObject({
      reason: 'mismatch',
    })
  })

  it('reports a gateway outage instead of throwing', async () => {
    const gw = gateway({})
    gw.getPayment = async () => {
      throw new Error('timeout')
    }
    expect(await confirmPayment(gw, {}, expected)).toMatchObject({
      ok: false,
      reason: 'gateway_error',
      detail: 'timeout',
    })
  })
})

describe('readCallbackBody', () => {
  const url = 'https://shop.example/callback'
  it('reads multipart (toyyibPay, measured), url-encoded, JSON and query strings', async () => {
    const { readCallbackBody } = await import('../src/index.js')
    const form = new FormData()
    form.set('billcode', 'abc')
    form.set('status', '1')
    expect(await readCallbackBody(new Request(url, { method: 'POST', body: form }))).toEqual({
      billcode: 'abc',
      status: '1',
    })
    const encoded = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two',
    })
    expect(await readCallbackBody(encoded)).toEqual({ a: '1', b: 'two' })
    const json = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 25, ok: true, nested: { x: 1 } }),
    })
    expect(await readCallbackBody(json)).toEqual({ amount: '25', ok: 'true' })
    expect(await readCallbackBody(new Request(`${url}?status_id=1&billcode=x`))).toEqual({
      status_id: '1',
      billcode: 'x',
    })
  })

  it('returns an empty object for a broken body instead of throwing', async () => {
    const { readCallbackBody } = await import('../src/index.js')
    const bad = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(await readCallbackBody(bad)).toEqual({})
  })
})
