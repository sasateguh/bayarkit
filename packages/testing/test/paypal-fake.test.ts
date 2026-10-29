import type { CallbackInput } from '@bayarkit/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import cli from '../src/cli/paypal.js'
import { startControlServer } from '../src/control.js'
import {
  type FakePayPal,
  PAYPAL_HEADERS,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalRefund,
  startFakePayPal,
} from '../src/fakes/paypal.js'

const ID = 'client_fake'
const SECRET = 'secret_fake'
const WEBHOOK = 'WH_FAKE'

type Json = Record<string, unknown>
/** One shape for every answer: tests read whichever fields the endpoint fills. */
type Answer = PayPalOrder &
  PayPalRefund & {
    name: string
    details: { issue: string; field?: string }[]
    access_token: string
    expires_in: number
    error: string
    verification_status: string
  }
type Event = { id: string; event_type: string; resource: PayPalCapture & Json }

const basic = (id = ID, secret = SECRET) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

describe('fake PayPal (OAuth, Orders v2, refunds, webhook postback)', () => {
  let fake: FakePayPal
  let token = ''
  beforeAll(async () => {
    fake = await startFakePayPal({ clientId: ID, clientSecret: SECRET, webhookId: WEBHOOK })
  })
  afterAll(() => fake.close())

  const getToken = async (auth = basic(), body = 'grant_type=client_credentials') => {
    const res = await fetch(`${fake.url}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    return { status: res.status, json: (await res.json()) as Answer }
  }

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (!token) token = (await getToken()).json.access_token
    const res = await fetch(`${fake.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: res.status, json: (await res.json()) as Answer }
  }

  const orderBody = (unit: Json = {}, over: Json = {}) => ({
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '10.50' }, custom_id: 'ORDER1', ...unit }],
    ...over,
  })
  const create = async (unit: Json = {}, over: Json = {}, headers: Record<string, string> = {}) => {
    const r = await call('POST', '/v2/checkout/orders', orderBody(unit, over), headers)
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json
  }
  const capture = (id: string, headers: Record<string, string> = {}) =>
    call('POST', `/v2/checkout/orders/${id}/capture`, {}, headers)

  it('issues a Bearer token for the right client only, as an OAuth 2.0 server does (spec §1)', async () => {
    const ok = await getToken()
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ token_type: 'Bearer', expires_in: 32400 })
    expect(ok.json.access_token).toMatch(/^A21AA/)
    const wrong = await getToken(basic(ID, 'nope'))
    expect(wrong.status).toBe(401)
    expect(wrong.json.error).toBe('invalid_client')
    expect((await getToken(basic(), 'grant_type=password')).json.error).toBe('unsupported_grant_type')
  })

  it('answers 401 AUTHENTICATION_FAILURE without a live token, and after expireTokens()', async () => {
    const none = await fetch(`${fake.url}/v2/checkout/orders/X`)
    expect(none.status).toBe(401)
    expect(((await none.json()) as Answer).name).toBe('AUTHENTICATION_FAILURE')
    const own = await startFakePayPal({ clientId: ID, clientSecret: SECRET, webhookId: WEBHOOK })
    const t = (
      (await (
        await fetch(`${own.url}/v1/oauth2/token`, {
          method: 'POST',
          headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        })
      ).json()) as Answer
    ).access_token
    const read = () => fetch(`${own.url}/v2/checkout/orders/X`, { headers: { authorization: `Bearer ${t}` } })
    expect((await read()).status).toBe(404)
    own.expireTokens()
    expect((await read()).status).toBe(401)
    await own.close()
  })

  it('creates a CREATED order with an approve link, or PAYER_ACTION_REQUIRED with experience_context (spec §2.2)', async () => {
    const plain = await create()
    expect(plain.status).toBe('CREATED')
    expect(plain.id).toMatch(/^[A-Z0-9]{17}$/)
    expect(plain.links.find((l) => l.rel === 'approve')?.href).toContain(`token=${plain.id}`)
    // Prefer defaults to return=minimal: id, status, links only.
    expect(Object.keys(plain).sort()).toEqual(['id', 'links', 'status'])
    const ctx = await create(
      {},
      { payment_source: { paypal: { experience_context: { return_url: 'https://shop.example/ok' } } } },
      { prefer: 'return=representation' },
    )
    expect(ctx.status).toBe('PAYER_ACTION_REQUIRED')
    expect(ctx.links.some((l) => l.rel === 'payer-action')).toBe(true)
    expect(ctx.purchase_units[0]).toMatchObject({
      reference_id: 'default',
      custom_id: 'ORDER1',
      amount: { currency_code: 'USD', value: '10.50' },
    })
    expect((await call('GET', `/v2/checkout/orders/${ctx.id}`)).json.status).toBe('PAYER_ACTION_REQUIRED')
  })

  it('refuses what the docs refuse, with PayPal error bodies (spec §2.1, §7)', async () => {
    const refused = async (unit: Json, over: Json = {}) => {
      const r = await call('POST', '/v2/checkout/orders', orderBody(unit, over))
      return { status: r.status, name: r.json.name, issue: r.json.details?.[0]?.issue }
    }
    expect(await refused({ amount: { currency_code: 'IDR', value: '10' } })).toMatchObject({
      status: 400,
      name: 'INVALID_REQUEST',
      issue: 'INVALID_CURRENCY_CODE',
    })
    expect(await refused({ amount: { currency_code: 'USD', value: 10.5 } })).toMatchObject({
      issue: 'INVALID_PARAMETER_SYNTAX',
    })
    expect(await refused({ amount: { currency_code: 'JPY', value: '500.5' } })).toMatchObject({
      status: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DECIMAL_PRECISION',
    })
    expect(await refused({ amount: { currency_code: 'USD', value: '10.505' } })).toMatchObject({
      issue: 'DECIMAL_PRECISION',
    })
    expect(await refused({ amount: { currency_code: 'USD', value: '0.00' } })).toMatchObject({
      issue: 'AMOUNT_NOT_POSITIVE',
    })
    expect(await refused({ amount: { currency_code: 'USD', value: '-1.00' } })).toMatchObject({
      issue: 'AMOUNT_NOT_POSITIVE',
    })
    expect(await refused({ custom_id: 'x'.repeat(256) })).toMatchObject({ issue: 'INVALID_STRING_LENGTH' })
    expect(await refused({ invoice_id: 'x'.repeat(128) })).toMatchObject({ issue: 'INVALID_STRING_LENGTH' })
    expect(await refused({}, { intent: 'AUTHORIZE' })).toMatchObject({ status: 400 })
    expect(await refused({}, { intent: undefined })).toMatchObject({ issue: 'MISSING_REQUIRED_PARAMETER' })
    expect(await refused({}, { purchase_units: [] })).toMatchObject({ issue: 'INVALID_ARRAY_MIN_ITEMS' })
    // Zero-decimal currencies take whole units; MYR takes two decimals.
    expect((await create({ amount: { currency_code: 'JPY', value: '500' } })).status).toBe('CREATED')
    expect((await create({ amount: { currency_code: 'MYR', value: '1.05' } })).status).toBe('CREATED')
    const missing = await call('GET', '/v2/checkout/orders/NOPE')
    expect(missing).toMatchObject({ status: 404, json: { name: 'RESOURCE_NOT_FOUND' } })
  })

  it('a repeated PayPal-Request-Id returns the first order instead of creating another (spec §4)', async () => {
    const key = { 'paypal-request-id': 'req-create-1' }
    const first = await create({}, {}, key)
    const again = await call('POST', '/v2/checkout/orders', orderBody({ custom_id: 'OTHER' }), key)
    expect(again.status).toBe(200)
    expect(again.json.id).toBe(first.id)
  })

  it('captures only an approved order; paid lives on the capture, not the order (spec §3, §4)', async () => {
    const o = await create()
    let r = await capture(o.id)
    expect(r).toMatchObject({ status: 422, json: { name: 'UNPROCESSABLE_ENTITY' } })
    fake.approve(o.id)
    expect((await call('GET', `/v2/checkout/orders/${o.id}`)).json.status).toBe('APPROVED')
    expect(fake.order(o.id)?.purchase_units[0]?.payments).toBeUndefined()
    r = await capture(o.id, { 'paypal-request-id': 'cap-1' })
    expect(r.status).toBe(201)
    const cap = r.json.purchase_units[0]?.payments?.captures[0]
    expect(r.json.status).toBe('COMPLETED')
    expect(cap).toMatchObject({
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '10.50' },
      custom_id: 'ORDER1',
      supplementary_data: { related_ids: { order_id: o.id } },
    })
    // Same request id: the same capture again (200), never a second one.
    const again = await capture(o.id, { 'paypal-request-id': 'cap-1' })
    expect(again.status).toBe(200)
    expect(again.json.purchase_units[0]?.payments?.captures[0]?.id).toBe(cap?.id)
    expect((await capture(o.id)).json.details[0]?.issue).toBe('ORDER_ALREADY_CAPTURED')
    expect((await call('GET', `/v2/payments/captures/${cap?.id}`)).json.status).toBe('COMPLETED')
  })

  it('nextCapture: a declined card completes the order with a DECLINED capture; PENDING holds it', async () => {
    const declined = await create()
    fake.nextCapture(declined.id, 'DECLINED')
    fake.markPaid(declined.id)
    const d = fake.order(declined.id)
    expect(d?.status).toBe('COMPLETED')
    expect(d?.purchase_units[0]?.payments?.captures[0]?.status).toBe('DECLINED')
    const pending = await create()
    fake.nextCapture(pending.id, 'PENDING')
    fake.approve(pending.id)
    const p = (await capture(pending.id)).json.purchase_units[0]?.payments?.captures[0]
    expect(p).toMatchObject({ status: 'PENDING', status_details: { reason: 'PENDING_REVIEW' } })
  })

  describe('refunds (POST /v2/payments/captures/{id}/refund, spec §6)', () => {
    const paid = async (unit: Json = {}) => {
      const o = await create(unit)
      fake.markPaid(o.id)
      return fake.order(o.id)?.purchase_units[0]?.payments?.captures[0]?.id ?? ''
    }
    const refund = (captureId: string, body: Json = {}, headers: Record<string, string> = {}) =>
      call('POST', `/v2/payments/captures/${captureId}/refund`, body, headers)

    it('an empty body refunds what remains; the capture becomes REFUNDED', async () => {
      const id = await paid()
      const r = await refund(id)
      expect(r.status).toBe(201)
      expect(r.json).toMatchObject({ status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.50' } })
      expect(fake.capture(id)?.status).toBe('REFUNDED')
      expect((await call('GET', `/v2/payments/refunds/${r.json.id}`)).json.id).toBe(r.json.id)
      expect((await refund(id)).json.details[0]?.issue).toBe('CAPTURE_STATUS_NOT_VALID')
    })

    it('partial refunds cannot exceed what remains; a repeated request id refunds once', async () => {
      const id = await paid()
      const part = (value: string, headers: Record<string, string> = {}) =>
        refund(id, { amount: { currency_code: 'USD', value } }, headers)
      expect((await part('10.51')).json.details[0]?.issue).toBe('REFUND_AMOUNT_EXCEEDED')
      const first = await part('3.00', { 'paypal-request-id': 'ref-1' })
      expect(first.status).toBe(201)
      const again = await part('3.00', { 'paypal-request-id': 'ref-1' })
      expect(again.status).toBe(200)
      expect(again.json.id).toBe(first.json.id)
      expect(fake.capture(id)?.status).toBe('PARTIALLY_REFUNDED')
      expect((await part('7.51')).json.details[0]?.issue).toBe('REFUND_AMOUNT_EXCEEDED')
      expect(
        (await refund(id, { amount: { currency_code: 'EUR', value: '1.00' } })).json.details[0]?.issue,
      ).toBe('REFUND_CURRENCY_MISMATCH')
      expect((await part('7.50')).json.status).toBe('COMPLETED')
      expect(fake.capture(id)?.status).toBe('REFUNDED')
      const related = fake.capture(id)?.supplementary_data as
        | { related_ids?: { order_id?: string } }
        | undefined
      const orderId = related?.related_ids?.order_id ?? ''
      expect(fake.order(orderId)?.purchase_units[0]?.payments?.refunds).toHaveLength(2)
    })

    it('nextRefund PENDING; refunds of a declined capture or an unknown one are refused', async () => {
      const id = await paid({ amount: { currency_code: 'JPY', value: '500' } })
      fake.nextRefund(id, 'PENDING')
      const r = await refund(id, { amount: { currency_code: 'JPY', value: '200' } })
      expect(r.json).toMatchObject({ status: 'PENDING', amount: { value: '200' } })
      expect((await refund(id)).json.amount.value).toBe('300')
      expect((await refund('NOPE')).status).toBe(404)
      const o = await create()
      fake.nextCapture(o.id, 'DECLINED')
      fake.markPaid(o.id)
      const declined = fake.order(o.id)?.purchase_units[0]?.payments?.captures[0]?.id ?? ''
      expect((await refund(declined)).status).toBe(422)
    })
  })

  describe('webhooks (spec §5)', () => {
    const verify = async (cb: CallbackInput, over: Json = {}, splice = true) => {
      const h = cb.headers
      const fields = {
        auth_algo: h['paypal-auth-algo'],
        cert_url: h['paypal-cert-url'],
        transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'],
        transmission_time: h['paypal-transmission-time'],
        webhook_id: WEBHOOK,
        ...over,
      }
      const raw = cb.rawBody ?? ''
      const body = splice
        ? `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${raw}}`
        : JSON.stringify({ ...fields, webhook_event: JSON.parse(raw) })
      return (await call('POST', '/v1/notifications/verify-webhook-signature', body)).json
    }

    it('callbackFor sends PAYMENT.CAPTURE.COMPLETED with the five PAYPAL-* headers, before markPaid too', async () => {
      const o = await create()
      const cb = fake.callbackFor(o.id)
      for (const h of PAYPAL_HEADERS) expect(cb.headers[h], h).toBeTruthy()
      const event = JSON.parse(cb.rawBody ?? '') as Event
      expect(event.event_type).toBe('PAYMENT.CAPTURE.COMPLETED')
      expect(event.id).toMatch(/^WH-/)
      expect(event.resource).toMatchObject({
        status: 'COMPLETED',
        custom_id: 'ORDER1',
        amount: { currency_code: 'USD', value: '10.50' },
        supplementary_data: { related_ids: { order_id: o.id } },
      })
      // The fake's own record is still unpaid: a signed callback alone proves nothing.
      expect(fake.order(o.id)?.status).toBe('CREATED')
      fake.markPaid(o.id)
      const real = JSON.parse(fake.callbackFor(o.id).rawBody ?? '') as Event
      expect(real.resource.id).toBe(fake.order(o.id)?.purchase_units[0]?.payments?.captures[0]?.id)
      const other = JSON.parse(
        fake.callbackFor(o.id, { event_type: 'PAYMENT.CAPTURE.DENIED', status: 'DECLINED' }).rawBody ?? '',
      ) as Event
      expect(other).toMatchObject({ event_type: 'PAYMENT.CAPTURE.DENIED', resource: { status: 'DECLINED' } })
      expect(() => fake.callbackFor('NOPE')).toThrow()
    })

    it('verify-webhook-signature: SUCCESS only for the raw event as sent, with this webhook id (spec §5.1)', async () => {
      const o = await create()
      const cb = fake.callbackFor(o.id)
      expect((await verify(cb)).verification_status).toBe('SUCCESS')
      // Re-serialised JSON, one changed byte, another webhook id, a tampered signature: FAILURE.
      expect((await verify(cb, {}, false)).verification_status).toBe('FAILURE')
      const changed = { ...cb, rawBody: (cb.rawBody ?? '').replace('10.50', '10.51') }
      expect((await verify(changed)).verification_status).toBe('FAILURE')
      expect((await verify(cb, { webhook_id: 'WH_OTHER' })).verification_status).toBe('FAILURE')
      expect((await verify(fake.tamper(cb))).verification_status).toBe('FAILURE')
      const tampered = fake.tamper(cb)
      expect(tampered.rawBody).toBe(cb.rawBody)
      expect(tampered.headers['paypal-transmission-sig']).not.toBe(cb.headers['paypal-transmission-sig'])
      const missing = await verify(cb, { webhook_id: '' })
      expect(missing).toMatchObject({ name: 'INVALID_REQUEST' })
    })
  })
})

describe('bayarkit-fake paypal (control API)', () => {
  it('starts with test defaults and answers /health, /paid and /callback', async () => {
    const fake = await cli.start({ ...cli.defaults })
    const control = await startControlServer('paypal', fake)
    expect(await (await fetch(`${control.url}/health`)).json()).toMatchObject({ ok: true, gateway: 'paypal' })
    const t = (await (
      await fetch(`${fake.url}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          authorization: basic(cli.defaults.clientId, cli.defaults.clientSecret),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      })
    ).json()) as Answer
    const res = await fetch(`${fake.url}/v2/checkout/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'MYR', value: '10.00' }, custom_id: 'R1' }],
      }),
    })
    const id = ((await res.json()) as Answer).id
    expect((await fetch(`${control.url}/paid/${id}`, { method: 'POST' })).status).toBe(204)
    const order = (await (
      await fetch(`${fake.url}/v2/checkout/orders/${id}`, {
        headers: { authorization: `Bearer ${t.access_token}` },
      })
    ).json()) as Answer
    expect(order.purchase_units[0]?.payments?.captures[0]?.status).toBe('COMPLETED')
    const cb = (await (await fetch(`${control.url}/callback/${id}`)).json()) as CallbackInput
    expect(cb.headers['paypal-transmission-sig']).toMatch(/^[A-Za-z0-9+/]+=*$/)
    await control.close()
    await fake.close()
  })
})
