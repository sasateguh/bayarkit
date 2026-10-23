/**
 * A fake Razorpay Curlec API (Payment Links + Orders), built from the official docs in `gateways/curlec/spec.md`
 * (curlec.com/docs `.md` exports, read 23 October 2026). NOT yet measured against a Test-mode account: when someone
 * does, change this file first so it answers like the real thing, then the adapter.
 *
 * What it checks, and where each rule comes from (spec keys in brackets):
 * - auth: `Authorization: Basic base64(key_id:key_secret)`, the scheme spelled exactly `Basic` [D2]. A bad header is
 *   answered 401 `{ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }` (ASSUMED: OC lists
 *   "Authentication failed." under 400, AU says 401; the adapter treats both as "an error is an error");
 * - JSON bodies and answers; errors `{ error: { code, description, source, step, reason, metadata, field? } }` [OC, PLC];
 * - `POST /v1/payment_links`: `amount` a JSON integer ≥ 100, `reference_id` ≤ 40 and unique, `callback_method: get`
 *   with `callback_url`, `expire_by` ≥ 15 min ahead, `customer.contact` 8–14 chars, unknown fields refused [PLC];
 * - `POST /v1/orders`: `amount` a JSON integer ≥ 100, `receipt` ≤ 40 ASCII and unique ("Duplicate request") [OC];
 * - a link gets its order only when the customer opens it (the official `payment_link.paid` sample has the order
 *   created after the link); the order's `receipt` is the link's `reference_id` (same sample), and the fetched link
 *   then carries `order_id` (fetch-id-standard sample);
 * - order status `created` → `attempted` → `paid` [OC]; link status `created` → `paid` [PLE];
 * - webhooks: JSON POST, `X-Razorpay-Signature` = hex HMAC-SHA256(webhook secret, RAW body), plus
 *   `x-razorpay-event-id` [WV]. The body is indented so a handler that re-serialises the parsed JSON (the official
 *   Node sample, WV L134) gets different bytes and fails;
 * - Payment Link redirect: GET query signed with the API key secret over
 *   `plink_id|reference_id|status|payment_id` [PLA]; Checkout callback: POST form signed with the API key secret over
 *   `order_id|payment_id` [CK].
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

type Entity = Record<string, unknown> & { id: string }

/** hex(HMAC-SHA256(secret, message)), written independently of the adapter. */
const hmacHex = (secret: string, message: string) =>
  createHmac('sha256', secret).update(message, 'utf8').digest('hex')

/** Webhook signature: the RAW body, keyed with the Dashboard webhook secret [WV L138-153]. */
export const curlecWebhookSignature = (webhookSecret: string, rawBody: string): string =>
  hmacHex(webhookSecret, rawBody)

export interface FakeCurlec extends FakeGateway {
  requests: {
    method: string
    path: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record (what `GET /v1/payment_links/{id}` or `GET /v1/orders/{id}` answers). */
  entity(id: string): Entity | undefined
  /** Simulate the customer opening a link (creates its order, `attempted`) or attempting an order. */
  attempt(id: string): Entity
  /** The Payment Link browser redirect (GET query), signed with the API key secret [PLA]. */
  redirectFor(id: string, override?: Record<string, string>): CallbackInput
  /** The Standard Checkout callback (POST form), signed with the API key secret [CK]. */
  checkoutCallbackFor(orderId: string, override?: Record<string, string>): CallbackInput
}

const randomId = (prefix: string) => `${prefix}${randomBytes(7).toString('hex')}`
const LINK_FIELDS = new Set([
  'amount',
  'currency',
  'accept_partial',
  'first_min_partial_amount',
  'upi_link',
  'description',
  'reference_id',
  'customer',
  'expire_by',
  'notify',
  'notes',
  'callback_url',
  'callback_method',
  'reminder_enable',
])

export async function startFakeCurlec(opts: {
  keyId: string
  keySecret: string
  webhookSecret: string
}): Promise<FakeCurlec> {
  const links = new Map<string, Entity>()
  const orders = new Map<string, Entity>()
  /** order id → captured payment id (kept apart so the order entity has only documented fields). */
  const paid = new Map<string, string>()
  const references = new Set<string>()
  const receipts = new Set<string>()
  const requests: FakeCurlec['requests'] = []
  const now = () => Math.floor(Date.now() / 1000)
  const basic = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`

  const error = (description: string, field?: string) => ({
    error: {
      code: 'BAD_REQUEST_ERROR',
      description,
      source: 'business',
      step: 'payment_initiation',
      reason: 'input_validation_failed',
      metadata: {},
      ...(field ? { field } : {}),
    },
  })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      let body: unknown = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = Symbol.for('bad-json')
        }
      }
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      if (req.headers.authorization !== basic) return send(401, error('Authentication failed'))
      if (typeof body === 'symbol') return send(400, error('EOF'))
      const b = (body ?? {}) as Record<string, unknown>

      if (req.method === 'POST' && path === '/v1/payment_links') return send(...createLink(b))
      if (req.method === 'POST' && path === '/v1/orders') return send(...createOrder(b))
      const link = /^\/v1\/payment_links\/([A-Za-z0-9_]+)$/.exec(path)
      if (req.method === 'GET' && link) {
        const l = links.get(link[1] ?? '')
        return l ? send(200, l) : send(400, error('The id provided does not exist'))
      }
      const order = /^\/v1\/orders\/([A-Za-z0-9_]+)$/.exec(path)
      if (req.method === 'GET' && order) {
        const o = orders.get(order[1] ?? '')
        return o ? send(200, o) : send(400, error('The id provided does not exist'))
      }
      return send(404, error('The requested URL was not found on the server.'))
    })
  })

  function validAmount(amount: unknown, field = 'amount'): string | null {
    if (amount === undefined) return `${field}: cannot be blank.`
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return 'The amount must be an integer.'
    if (amount < 100) return 'The amount must be at least MYR 1.00'
    return null
  }

  function createLink(b: Record<string, unknown>): [number, unknown] {
    const extra = Object.keys(b).filter((k) => !LINK_FIELDS.has(k))
    if (extra.length) return [400, error('extra fields sent.', extra[0])]
    const bad = validAmount(b.amount)
    if (bad) return [400, error(bad, 'amount')]
    if ((b.currency ?? 'MYR') !== 'MYR')
      return [400, error('amount: currency: wrong input field', 'currency')]
    const ref = b.reference_id
    if (ref !== undefined) {
      if (typeof ref !== 'string' || ref.length > 40)
        return [400, error('reference_id: the length must be no more than 40.', 'reference_id')]
      if (references.has(ref))
        return [400, error('payment link creation with reference ID already attempted', 'reference_id')]
    }
    if (b.callback_url !== undefined) {
      if (typeof b.callback_url !== 'string' || !/^https?:\/\//.test(b.callback_url))
        return [400, error('callback_url: URL should be sent in callback_url field.', 'callback_url')]
      if (b.callback_method !== 'get')
        return [400, error('callback_method: must be a valid value.', 'callback_method')]
    }
    if (b.expire_by !== undefined) {
      if (typeof b.expire_by !== 'number' || !Number.isInteger(b.expire_by))
        return [400, error('incorrect JSON object received - faulty key: expire_by.', 'expire_by')]
      if (b.expire_by < now() + 15 * 60)
        return [400, error('timestamp must be atleast 15 minutes in future', 'expire_by')]
    }
    const customer = (b.customer ?? {}) as Record<string, unknown>
    if (customer.contact !== undefined) {
      const c = String(customer.contact)
      if (c.length < 8 || c.length > 14)
        return [400, error('contact: the length must be between 8 and 14.', 'contact')]
    }
    if (b.accept_partial === false && b.first_min_partial_amount !== undefined)
      return [
        400,
        error('first_min_partial_amount: amount should be minimum 100', 'first_min_partial_amount'),
      ]
    if (typeof ref === 'string') references.add(ref)
    const id = randomId('plink_')
    const created = now()
    const link: Entity = {
      id,
      accept_partial: b.accept_partial === true,
      amount: b.amount,
      amount_paid: 0,
      callback_method: b.callback_method ?? null,
      callback_url: b.callback_url ?? null,
      cancelled_at: 0,
      created_at: created,
      currency: 'MYR',
      customer,
      description: b.description ?? '',
      expire_by: b.expire_by ?? 0,
      expired_at: 0,
      first_min_partial_amount: 0,
      notes: b.notes ?? null,
      notify: b.notify ?? { email: false, sms: false },
      payments: null,
      reference_id: ref ?? '',
      reminder_enable: b.reminder_enable === true,
      reminders: [],
      short_url: `https://rzp.io/i/${id.slice(6)}`,
      status: 'created',
      updated_at: created,
      user_id: '',
    }
    links.set(id, link)
    return [200, link]
  }

  function newOrder(amount: number, receipt: string | null, notes: unknown): Entity {
    const id = randomId('order_')
    const order: Entity = {
      id,
      entity: 'order',
      amount,
      amount_paid: 0,
      amount_due: amount,
      currency: 'MYR',
      receipt,
      offer_id: null,
      status: 'created',
      attempts: 0,
      notes: notes ?? [],
      created_at: now(),
    }
    orders.set(id, order)
    return order
  }

  function createOrder(b: Record<string, unknown>): [number, unknown] {
    const bad = validAmount(b.amount)
    if (bad) return [400, error(bad, 'amount')]
    if (b.currency !== 'MYR')
      return [400, error('currency: validation_failure: BAD_REQUEST_INVALID_CURRENCY.', 'currency')]
    const receipt = b.receipt
    if (receipt !== undefined) {
      if (typeof receipt !== 'string' || receipt.length > 40)
        return [400, error('receipt: the length must be no more than 40.', 'receipt')]
      if (!/^[\x20-\x7e]*$/.test(receipt))
        return [
          400,
          error('The receipt: validation_failure: BAD_REQUEST_ENCODING_VALIDATION_FAILED.', 'receipt'),
        ]
      if (receipts.has(receipt))
        return [400, error('Duplicate request. This request has already been processed.')]
      receipts.add(receipt)
    }
    return [200, newOrder(b.amount as number, (receipt as string | undefined) ?? null, b.notes)]
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const find = (id: string): Entity => {
    const e = links.get(id) ?? orders.get(id)
    if (!e) throw new Error(`fake Curlec: no payment link or order ${id}`)
    return e
  }

  /** The order behind an id: the order itself, or the link's (created, `attempted`, when the customer opens it). */
  function orderOf(id: string): Entity {
    const e = find(id)
    if (!id.startsWith('plink_')) return e
    const existing = typeof e.order_id === 'string' ? orders.get(e.order_id) : undefined
    if (existing) return existing
    const order = newOrder(e.amount as number, String(e.reference_id ?? ''), [])
    e.order_id = order.id
    return order
  }

  function attempt(id: string): Entity {
    const order = orderOf(id)
    if (order.status === 'created') order.status = 'attempted'
    order.attempts = (order.attempts as number) + 1
    return order
  }

  /** A captured payment entity for this order, as the webhook samples show it [WO, WP]. */
  const paymentFor = (order: Entity): Entity => {
    const id = paid.get(order.id) ?? randomId('pay_')
    return {
      id,
      entity: 'payment',
      amount: order.amount,
      currency: 'MYR',
      status: 'captured',
      order_id: order.id,
      invoice_id: null,
      international: false,
      method: 'fpx',
      amount_refunded: 0,
      refund_status: null,
      captured: true,
      description: null,
      card_id: null,
      bank: 'TEST0021',
      wallet: null,
      email: 'void@curlec.example',
      contact: '+60123456789',
      notes: [],
      fee: 2,
      tax: 0,
      error_code: null,
      error_description: null,
      created_at: now(),
    }
  }

  return {
    url,
    requests,
    entity: (id) => links.get(id) ?? orders.get(id),
    attempt,
    markPaid(id) {
      const order = attempt(id)
      const payment = paymentFor(order)
      paid.set(order.id, payment.id)
      order.status = 'paid'
      order.amount_paid = order.amount
      order.amount_due = 0
      const link = links.get(id)
      if (link) {
        link.status = 'paid'
        link.amount_paid = link.amount
        link.updated_at = now()
        link.payments = [
          {
            amount: payment.amount,
            created_at: payment.created_at,
            method: 'fpx',
            payment_id: payment.id,
            plink_id: link.id,
            status: 'captured',
            updated_at: now(),
          },
        ]
      }
    },
    /**
     * A webhook claiming payment (even before `markPaid`; the fake's own records stay as they are): `payment_link.paid`
     * for a link, `order.paid` for an order. `override.event` changes the event; other keys change the payment entity.
     */
    callbackFor(id, override = {}) {
      const { event: eventName, ...fields } = override
      const order = orderOf(id)
      const link = links.get(id)
      const payment = { ...paymentFor(order), ...fields }
      const claimedOrder = { ...order, status: 'paid', amount_paid: order.amount, amount_due: 0 }
      const payload: Record<string, unknown> = {
        payment: { entity: payment },
        order: { entity: claimedOrder },
      }
      if (link) payload.payment_link = { entity: { ...link, status: 'paid', amount_paid: link.amount } }
      const event = {
        entity: 'event',
        account_id: 'acc_FakeCurlec0001',
        event: eventName ?? (link ? 'payment_link.paid' : 'order.paid'),
        contains: link ? ['payment_link', 'order', 'payment'] : ['payment', 'order'],
        payload,
        created_at: now(),
      }
      const rawBody = JSON.stringify(event, null, 2)
      return {
        fields: {},
        rawBody,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-event-id': randomId('evt_'),
          'x-razorpay-signature': curlecWebhookSignature(opts.webhookSecret, rawBody),
        },
      }
    },
    redirectFor(id, override = {}) {
      const link = links.get(id)
      if (!link) throw new Error(`fake Curlec: no payment link ${id}`)
      const order = orderOf(id)
      const fields: Record<string, string> = {
        razorpay_payment_id: paid.get(order.id) ?? randomId('pay_'),
        razorpay_payment_link_id: link.id,
        razorpay_payment_link_reference_id: String(link.reference_id ?? ''),
        razorpay_payment_link_status: 'paid',
        ...override,
      }
      fields.razorpay_signature = hmacHex(
        opts.keySecret,
        `${fields.razorpay_payment_link_id}|${fields.razorpay_payment_link_reference_id}|${fields.razorpay_payment_link_status}|${fields.razorpay_payment_id}`,
      )
      return { fields, rawBody: '', headers: {} }
    },
    checkoutCallbackFor(orderId, override = {}) {
      const order = orders.get(orderId)
      if (!order) throw new Error(`fake Curlec: no order ${orderId}`)
      const fields: Record<string, string> = {
        razorpay_payment_id: paid.get(order.id) ?? randomId('pay_'),
        razorpay_order_id: order.id,
        ...override,
      }
      fields.razorpay_signature = hmacHex(
        opts.keySecret,
        `${fields.razorpay_order_id}|${fields.razorpay_payment_id}`,
      )
      return {
        fields,
        rawBody: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper: (cb) =>
      cb.headers['x-razorpay-signature'] !== undefined
        ? {
            ...cb,
            headers: { ...cb.headers, 'x-razorpay-signature': flip(cb.headers['x-razorpay-signature']) },
          }
        : { ...cb, fields: { ...cb.fields, razorpay_signature: flip(cb.fields.razorpay_signature ?? '') } },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
