import type { CallbackInput } from '@bayarkit/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import cli from '../src/cli/paddle.js'
import { startControlServer } from '../src/control.js'
import {
  type FakePaddle,
  PADDLE_VERSION,
  type PaddleAdjustment,
  type PaddleTransaction,
  paddleSignature,
  startFakePaddle,
} from '../src/fakes/paddle.js'

const KEY = 'pdl_sdbx_apikey_fake'
const SECRET = 'pdl_ntfset_fake'

type Json = Record<string, unknown>
/** One shape for every answer: tests read whichever half the endpoint fills. */
type Answer = { data: PaddleTransaction & PaddleAdjustment; error: { type: string; code: string } }
type Event = { event_type: string; event_id: string; notification_id: string; data: PaddleTransaction }

describe('fake Paddle (Billing API, transactions + adjustments)', () => {
  let fake: FakePaddle
  beforeAll(async () => {
    fake = await startFakePaddle({ apiKey: KEY, webhookSecret: SECRET })
  })
  afterAll(() => fake.close())

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${fake.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        'paddle-version': PADDLE_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: res.status, json: (await res.json()) as Answer }
  }

  const txnBody = (over: Json = {}, price: Json = {}) => ({
    items: [
      {
        quantity: 1,
        price: {
          description: 'Order ORDER1',
          name: 'Order ORDER1',
          tax_mode: 'internal',
          unit_price: { amount: '1050', currency_code: 'USD' },
          product: { name: 'Order ORDER1', tax_category: 'standard' },
          ...price,
        },
      },
    ],
    custom_data: { reference: 'ORDER1' },
    ...over,
  })

  const create = async (over: Json = {}, price: Json = {}) => {
    const r = await call('POST', '/transactions', txnBody(over, price))
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json.data
  }

  it('signs exactly like the official SDK test vector (spec §4)', () => {
    expect(paddleSignature('VALID_SECRET', '{"data": ["1", "2"]}', 1698796800)).toBe(
      'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9',
    )
    // During secret rotation Paddle sends one h1 per secret.
    expect(paddleSignature(['a', 'b'], '{}', 1).match(/;h1=/g)).toHaveLength(2)
  })

  it('answers 403 with the documented codes when the key is missing, malformed or wrong', async () => {
    const missing = await fetch(`${fake.url}/transactions/txn_x`, { headers: { 'paddle-version': '1' } })
    expect(missing.status).toBe(403)
    expect(((await missing.json()) as Answer).error).toMatchObject({
      type: 'request_error',
      code: 'authentication_missing',
    })
    expect(
      (await call('GET', '/transactions/txn_x', undefined, { authorization: KEY })).json.error.code,
    ).toBe('authentication_malformed')
    const wrong = await call('GET', '/transactions/txn_x', undefined, { authorization: 'Bearer pdl_other' })
    expect(wrong.status).toBe(403)
    expect(wrong.json.error.code).toBe('invalid_token')
  })

  it('requires Paddle-Version 1, so a test proves the adapter pins it', async () => {
    const none = await fetch(`${fake.url}/transactions/txn_x`, {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(none.status).toBe(400)
    expect((await call('GET', '/transactions/txn_x', undefined, { 'paddle-version': '2' })).status).toBe(400)
  })

  it('creates a draft transaction with a payment link carrying _ptxn and string totals', async () => {
    const t = await create()
    expect(t.id).toMatch(/^txn_[a-z\d]{26}$/)
    expect(t.status).toBe('draft')
    expect(t.collection_mode).toBe('automatic')
    expect(t.currency_code).toBe('USD')
    expect(t.custom_data).toEqual({ reference: 'ORDER1' })
    expect(t.checkout.url).toBe(`https://shop.example/pay?_ptxn=${t.id}`)
    expect(t.details.totals).toMatchObject({ grand_total: '1050', total: '1050', balance: '1050' })
    expect(t.details.line_items[0]?.id).toMatch(/^txnitm_/)
    expect(t.payments).toEqual([])
    expect((await call('GET', `/transactions/${t.id}`)).json.data).toEqual(t)
  })

  it('builds the link on a checkout.url passed with the request', async () => {
    const t = await create({ checkout: { url: 'https://shop.example/buy' } })
    expect(t.checkout.url).toBe(`https://shop.example/buy?_ptxn=${t.id}`)
  })

  it('adds tax on top unless the price is tax-inclusive (merchant of record, spec §2.3)', async () => {
    for (const tax_mode of ['external', 'account_setting', undefined]) {
      const t = await create({}, { tax_mode })
      expect(Number(t.details.totals.grand_total)).toBeGreaterThan(1050)
      expect(t.details.totals.subtotal).toBe('1050')
    }
    const two = await create({}, { unit_price: { amount: '500', currency_code: 'USD' } })
    expect(two.details.totals.grand_total).toBe('500')
  })

  it('refuses what the docs refuse, with Paddle error bodies', async () => {
    const code = async (body: unknown) => (await call('POST', '/transactions', body)).json.error?.code
    expect(await code('{')).toBe('invalid_json')
    expect(await code(txnBody({}, { unit_price: { amount: '1050', currency_code: 'MYR' } }))).toBe(
      'invalid_field',
    )
    expect(await code(txnBody({}, { unit_price: { amount: 1050, currency_code: 'USD' } }))).toBe(
      'invalid_field',
    )
    expect(await code(txnBody({}, { unit_price: { amount: '10.50', currency_code: 'USD' } }))).toBe(
      'invalid_field',
    )
    expect(await code(txnBody({}, { description: 'x' }))).toBe('invalid_field')
    expect(await code(txnBody({}, { product: { name: 'p', tax_category: 'nonsense' } }))).toBe(
      'invalid_field',
    )
    expect(await code(txnBody({ custom_data: {} }))).toBe('invalid_field')
    expect(await code(txnBody({ items: [] }))).toBe('invalid_field')
    expect(await code(txnBody({}, { unit_price: { amount: '69', currency_code: 'USD' } }))).toBe(
      'transaction_balance_less_than_charge_limit',
    )
    expect(await code(txnBody({ checkout: { url: 'https://evil.example/pay' } }))).toBe(
      'transaction_checkout_url_domain_is_not_approved',
    )
    const res = await call('GET', '/transactions/txn_00000000000000000000000000')
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })

  it('refuses every transaction when no default payment link is set', async () => {
    const bare = await startFakePaddle({ apiKey: KEY, webhookSecret: SECRET, defaultPaymentLink: '' })
    const res = await fetch(`${bare.url}/transactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'paddle-version': '1', 'content-type': 'application/json' },
      body: JSON.stringify(txnBody()),
    })
    expect(((await res.json()) as Answer).error.code).toBe('transaction_default_checkout_url_not_set')
    await bare.close()
  })

  it('markPaid completes the transaction with a captured payment; a decline leaves it unpaid', async () => {
    const t = await create()
    fake.decline(t.id)
    let read = (await call('GET', `/transactions/${t.id}`)).json.data
    expect(read.status).toBe('draft')
    expect(read.payments[0]).toMatchObject({ status: 'error', error_code: 'declined' })
    fake.markPaid(t.id)
    read = (await call('GET', `/transactions/${t.id}`)).json.data
    expect(read.status).toBe('completed')
    expect(read.payments[0]).toMatchObject({ status: 'captured', amount: '1050' })
  })

  it('callbackFor signs the raw body with Paddle-Signature and claims completion before markPaid', async () => {
    const t = await create()
    const cb = fake.callbackFor(t.id)
    const header = cb.headers['paddle-signature'] ?? ''
    const ts = Number(/^ts=(\d+);/.exec(header)?.[1])
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5)
    expect(header).toBe(paddleSignature(SECRET, cb.rawBody ?? '', ts))
    const event = JSON.parse(cb.rawBody ?? '') as Event
    expect(event).toMatchObject({
      event_type: 'transaction.completed',
      data: { id: t.id, status: 'completed' },
    })
    expect(event.event_id).toMatch(/^evt_/)
    expect(event.notification_id).toMatch(/^ntf_/)
    expect(event.data.custom_data).toEqual({ reference: 'ORDER1' })
    // The fake's own record is still unpaid: a signed callback alone proves nothing.
    expect((await call('GET', `/transactions/${t.id}`)).json.data.status).toBe('draft')
    const other = JSON.parse(
      fake.callbackFor(t.id, { event_type: 'transaction.paid', status: 'paid' }).rawBody ?? '',
    )
    expect(other).toMatchObject({ event_type: 'transaction.paid', data: { status: 'paid' } })
    const bad: CallbackInput = fake.tamper(cb)
    expect(bad.rawBody).toBe(cb.rawBody)
    expect(bad.headers['paddle-signature']).not.toBe(header)
    expect(() => fake.callbackFor('txn_missing')).toThrow()
  })

  describe('refunds (POST /adjustments, spec §5)', () => {
    const refund = (body: Json) => call('POST', '/adjustments', { action: 'refund', reason: 'test', ...body })

    it('refunds only completed transactions', async () => {
      const t = await create()
      const r = await refund({ transaction_id: t.id, type: 'full' })
      expect(r.json.error.code).toBe('adjustment_transaction_invalid_status_for_refund')
      expect((await refund({ transaction_id: 'txn_nope', type: 'full' })).status).toBe(404)
    })

    it('a full refund waits for approval, blocks a second one, and lowers adjusted totals once approved', async () => {
      const t = await create()
      fake.markPaid(t.id)
      const r = await refund({ transaction_id: t.id, type: 'full' })
      expect(r.status).toBe(201)
      expect(r.json.data).toMatchObject({
        action: 'refund',
        transaction_id: t.id,
        status: 'pending_approval',
        currency_code: 'USD',
        totals: { total: '1050' },
      })
      expect(r.json.data.id).toMatch(/^adj_/)
      expect((await refund({ transaction_id: t.id, type: 'full' })).json.error.code).toBe(
        'adjustment_pending_refund_request',
      )
      let read = (await call('GET', `/transactions/${t.id}`)).json.data
      expect(read.details.adjusted_totals.grand_total).toBe('1050')
      fake.approveRefunds()
      expect(fake.adjustment(r.json.data.id)?.status).toBe('approved')
      read = (await call('GET', `/transactions/${t.id}`)).json.data
      expect(read.status).toBe('completed')
      expect(read.details.adjusted_totals.grand_total).toBe('0')
    })

    it('partial refunds name a line item and cannot exceed what remains', async () => {
      const t = await create()
      fake.markPaid(t.id)
      const item_id = t.details.line_items[0]?.id ?? ''
      const part = (amount: string) =>
        refund({ transaction_id: t.id, items: [{ item_id, type: 'partial', amount }] })
      expect((await part('1051')).json.error.code).toBe('adjustment_amount_above_remaining_allowed')
      expect((await part('0')).json.error.code).toBe('adjustment_amount_cannot_be_zero')
      expect((await part('1.5')).json.error.code).toBe('invalid_field')
      expect(
        (
          await refund({
            transaction_id: t.id,
            items: [{ item_id: 'txnitm_nope', type: 'partial', amount: '1' }],
          })
        ).json.error.code,
      ).toBe('adjustment_transaction_item_invalid')
      const first = await part('300')
      expect(first.json.data).toMatchObject({ status: 'pending_approval', totals: { total: '300' } })
      fake.approveRefunds()
      expect((await part('751')).json.error.code).toBe('adjustment_amount_above_remaining_allowed')
      expect((await part('750')).status).toBe(201)
    })

    it('validates reason, action and tax_mode', async () => {
      const t = await create()
      fake.markPaid(t.id)
      expect((await refund({ transaction_id: t.id, type: 'full', reason: ' ' })).json.error.code).toBe(
        'invalid_field',
      )
      expect((await refund({ transaction_id: t.id, type: 'full', action: 'credit' })).json.error.code).toBe(
        'invalid_field',
      )
      expect(
        (await refund({ transaction_id: t.id, type: 'full', tax_mode: 'external' })).json.error.code,
      ).toBe('adjustment_tax_mode_not_allowed')
      expect((await refund({ transaction_id: t.id })).json.error.code).toBe('invalid_field')
    })
  })
})

describe('bayarkit-fake paddle (control API)', () => {
  it('starts with test defaults and answers /health, /paid and /callback', async () => {
    const fake = await cli.start({ ...cli.defaults })
    const control = await startControlServer('paddle', fake)
    expect(await (await fetch(`${control.url}/health`)).json()).toMatchObject({ ok: true, gateway: 'paddle' })
    const res = await fetch(`${fake.url}/transactions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cli.defaults.apiKey}`,
        'paddle-version': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [
          {
            quantity: 1,
            price: {
              description: 'Order R1',
              tax_mode: 'internal',
              unit_price: { amount: '1000', currency_code: 'USD' },
              product: { name: 'Order R1', tax_category: 'standard' },
            },
          },
        ],
        custom_data: { reference: 'R1' },
      }),
    })
    const id = ((await res.json()) as Answer).data.id
    expect((await fetch(`${control.url}/paid/${id}`, { method: 'POST' })).status).toBe(204)
    const cb = (await (await fetch(`${control.url}/callback/${id}`)).json()) as CallbackInput
    expect(cb.headers['paddle-signature']).toMatch(/^ts=\d+;h1=[0-9a-f]{64}$/)
    await control.close()
    await fake.close()
  })
})
