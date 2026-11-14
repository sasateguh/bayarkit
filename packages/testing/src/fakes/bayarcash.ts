/**
 * A fake Bayarcash API v3. Shapes MEASURED on the sandbox 27 Oct 2026 (api.console.bayarcash-sandbox.com, FPX mock bank,
 * one paid and one failed payment): creating an intent answers 201 with `amount` as a number and one `payment_channel`;
 * `GET /payment-intents/{id}` answers 201 (a read, still 201) with `status` "unpaid"/"paid" and its `attempts`;
 * `/transactions/{intent id}` is 404 (an intent is not a transaction); a transaction names its portal by NAME (`portal`),
 * not by key. Callback field lists still come from the official PHP SDK: the sandbox sent no server callback.
 * Recurring payments (SDK, 10 Nov 2026): every charge is a `record_type: recurring_charge` callback signed over 22 fixed
 * fields, and the payer lands on the recurring return URL with 12 signed fields (`recurring_type`, no `record_type`);
 * a field the form body drops is signed as ''. The adapter does not support recurring; these let tests prove it refuses.
 */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

const sign = (secret: string, fields: Record<string, string>) =>
  createHmac('sha256', secret)
    .update(
      Object.keys(fields)
        .sort()
        .map((k) => fields[k] ?? '')
        .join('|'),
    )
    .digest('hex')

interface Intent {
  id: string
  body: Record<string, unknown>
  transactionId?: string
}

const RECURRING_CHARGE_FIELDS = [
  'record_type',
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'order_number',
  'currency',
  'amount',
  'payer_name',
  'payer_email',
  'payer_bank_name',
  'status',
  'status_description',
  'datetime',
  'charge_source',
  'subscription_id',
  'installment_id',
  'customer_id',
  'card_brand',
  'card_country',
  'card_last4',
  'card_exp_month',
  'card_exp_year',
]
const RECURRING_RETURN_FIELDS = [
  'recurring_type',
  'status',
  'customer_id',
  'subscription_id',
  'installment_id',
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'currency',
  'amount',
  'transaction_status',
  'transaction_status_description',
]
/** The SDK's fixed-field checksum: every listed field, '' when absent (null fields are dropped from a form body). */
const signFixed = (secret: string, fields: Record<string, string>, names: string[]) =>
  sign(secret, Object.fromEntries(names.map((k) => [k, fields[k] ?? ''])))

// Descriptions are the fake's own wording (the reference names the codes, not the text a transaction carries).
const DESCRIPTIONS: Record<string, string> = {
  '2': 'Failed',
  '3': 'Approved',
  '4': 'Cancelled',
  '5': 'Abandoned',
  '6': 'Authorized',
  '7': 'Void',
  '8': 'Refund',
}

export interface FakeBayarcash extends FakeGateway {
  /** A successful recurring charge callback (`record_type: recurring_charge`), signed the SDK's way. */
  recurringChargeCallback(override?: Record<string, string>): CallbackInput
  /** The payer's landing on the recurring return URL after enrolment, signed the SDK's way. */
  recurringReturn(override?: Record<string, string>): CallbackInput
  /**
   * Give the intent's transaction a numeric status (as a string, e.g. '6'). API reference statuses: 0 New · 1 Pending ·
   * 2 Failed · 3 Success · 4 Cancelled · 5 Abandoned · 6 Authorized · 7 Void · 8 Refund (5–8 in the callback table since
   * 10 Nov 2026).
   */
  setTransactionStatus(id: string, status: string): void
  requests: {
    method: string
    path: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
}

export async function startFakeBayarcash(opts: {
  token: string
  secretKey: string
  portalKey: string
  /** Shown as `portal` on every transaction and in GET /portals. */
  portalName?: string
  /** Other portals in the account, listed BEFORE this one (newest first, as measured), to exercise pagination. */
  otherPortals?: number
}): Promise<FakeBayarcash> {
  const portalName = opts.portalName ?? 'Fake portal'
  let n = 0
  const intents = new Map<string, Intent>()
  const transactions = new Map<string, Record<string, string>>()
  const requests: FakeBayarcash['requests'] = []

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {}
      const path = req.url ?? ''
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      if (req.headers.authorization !== `Bearer ${opts.token}`)
        return send(401, { message: 'Unauthenticated.' })

      if (req.method === 'POST' && path === '/payment-intents') {
        // order_number rules MEASURED on the sandbox 11 Nov 2026 (undocumented). Field errors come before the checksum
        // (measured: 31 characters with a wrong checksum → the length error first); the server trims before checking
        // the checksum, so a leading or trailing space → "Data checksum mismatch.".
        const order = String(body.order_number ?? '').trim()
        const orderErrors: string[] = []
        if (!order) orderErrors.push('Missing Order Number.')
        else {
          if (!/^[A-Za-z0-9 "()*,\-./:;@\\_`~]*$/.test(order))
            orderErrors.push('The order number field format is invalid.')
          if ([...order].length > 30)
            orderErrors.push('The order number field must not be greater than 30 characters.')
        }
        if (orderErrors.length) {
          const more = orderErrors.length > 1 ? ` (and ${orderErrors.length - 1} more error)` : ''
          return send(422, {
            code: 422,
            message: `${orderErrors[0]}${more}`,
            errors: { order_number: orderErrors },
          })
        }
        const channels = Array.isArray(body.payment_channel)
          ? body.payment_channel.join(',')
          : String(body.payment_channel)
        const expected = sign(opts.secretKey, {
          payment_channel: channels,
          order_number: order,
          amount: String(body.amount ?? ''),
          payer_name: String(body.payer_name ?? ''),
          payer_email: String(body.payer_email ?? ''),
        })
        if (body.checksum !== expected) return send(422, { message: 'Data checksum mismatch.' })
        if (body.portal_key !== opts.portalKey) return send(422, { message: 'Invalid portal key.' })
        const id = `pi_fake${++n}`
        intents.set(id, { id, body })
        return send(201, {
          type: 'payment_intent',
          id,
          payer_name: body.payer_name,
          payer_email: body.payer_email,
          payer_telephone_number: '',
          order_number: body.order_number,
          amount: Number(body.amount),
          payment_channel: Number(String(channels).split(',')[0]),
          url: `https://fake.bayarcash.test/payment-intent/${id}`,
        })
      }
      const pi = /^\/payment-intents\/([A-Za-z0-9_-]+)$/.exec(path)
      if (req.method === 'GET' && pi) {
        const i = intents.get(pi[1] ?? '')
        if (!i) return send(404, { code: 404, message: 'Resource not found.' })
        const t = i.transactionId ? transactions.get(i.transactionId) : undefined
        const paid = t?.status === '3'
        return send(201, {
          type: 'payment_intent',
          id: i.id,
          status: paid ? 'paid' : 'unpaid',
          last_attempt: t ? t.datetime : null,
          paid_at: paid ? t?.datetime : '',
          order_number: i.body.order_number,
          amount: Number(i.body.amount),
          currency: 'MYR',
          attempts: t
            ? [
                {
                  transaction_id: t.transaction_id,
                  order_number: t.order_number,
                  amount: Number(t.amount),
                  status: Number(t.status),
                },
              ]
            : [],
        })
      }
      const tx = /^\/transactions\/([A-Za-z0-9_-]+)$/.exec(path)
      if (req.method === 'GET' && tx) {
        const t = transactions.get(tx[1] ?? '')
        if (!t) return send(404, { code: 404, message: 'Resource not found.' })
        const { record_type: _, transaction_id, ...rest } = t
        return send(200, {
          ...rest,
          id: transaction_id,
          amount: Number(t.amount),
          status: Number(t.status),
          portal: portalName,
          payment_intent_id: [...intents.values()].find((i) => i.transactionId === transaction_id)?.id,
        })
      }
      if (req.method === 'GET' && (path === '/portals' || path.startsWith('/portals?'))) {
        // MEASURED 11 Nov 2026: paginated, 15 per page unless `per_page`; `portal_key` filters (undocumented).
        const q = new URL(path, 'http://x').searchParams
        const all = [
          ...Array.from({ length: opts.otherPortals ?? 0 }, (_, i) => ({
            portal_key: `other${i}`,
            portal_name: `Other portal ${i}`,
            payment_channels: [{ id: 1, name: 'FPX' }],
          })),
          { portal_key: opts.portalKey, portal_name: portalName, payment_channels: [{ id: 1, name: 'FPX' }] },
        ]
        const filtered = q.has('portal_key') ? all.filter((p) => p.portal_key === q.get('portal_key')) : all
        const per = Math.max(1, Number(q.get('per_page')) || 15)
        const page = Math.max(1, Number(q.get('page')) || 1)
        const last = Math.max(1, Math.ceil(filtered.length / per))
        return send(200, {
          data: filtered.slice((page - 1) * per, page * per),
          meta: { current_page: page, last_page: last, per_page: per, total: filtered.length },
        })
      }
      send(404, { message: 'Not found.' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const intent = (id: string) => {
    const i = intents.get(id)
    if (!i) throw new Error(`fake Bayarcash: no payment intent ${id}`)
    return i
  }
  const transaction = (i: Intent, status: string) => {
    i.transactionId ??= `trx_${i.id}`
    const t: Record<string, string> = {
      record_type: 'transaction',
      transaction_id: i.transactionId,
      exchange_reference_number: `1-${i.id}`,
      exchange_transaction_id: `FPX${i.id}`,
      order_number: String(i.body.order_number ?? ''),
      currency: 'MYR',
      amount: String(i.body.amount ?? ''),
      payer_name: String(i.body.payer_name ?? ''),
      payer_email: String(i.body.payer_email ?? ''),
      payer_bank_name: 'Test Bank',
      status,
      status_description: DESCRIPTIONS[status] ?? 'Pending',
      datetime: '2026-10-23 10:00:00',
    }
    transactions.set(i.transactionId, t)
    return t
  }

  return {
    url,
    requests,
    markPaid(id) {
      transaction(intent(id), '3')
    },
    setTransactionStatus(id, status) {
      transaction(intent(id), status)
    },
    callbackFor(id, override = {}) {
      const i = intent(id)
      // A callback before payment: the gateway's own record stays pending, the callback still claims success.
      const base = transactions.get(i.transactionId ?? '') ?? transaction(i, '1')
      const fields: Record<string, string> = {
        ...base,
        status: '3',
        status_description: 'Approved',
        ...override,
      }
      const { checksum, ...signed } = fields
      return {
        fields: { ...signed, checksum: checksum ?? sign(opts.secretKey, signed) },
        rawBody: '',
        headers: {},
      }
    },
    recurringChargeCallback(override = {}) {
      // order_number and payer_bank_name are always null on a recurring charge, so the form body leaves them out.
      const fields: Record<string, string> = {
        record_type: 'recurring_charge',
        transaction_id: 'trx_rc_1',
        exchange_reference_number: '1-rc-1',
        exchange_transaction_id: 'CCrc1',
        currency: 'MYR',
        amount: '25.00',
        payer_name: 'Payer',
        payer_email: 'payer@example.test',
        status: '3',
        status_description: 'Approved',
        datetime: '2026-11-10 10:00:00',
        charge_source: 'subscription',
        subscription_id: 'sub_1',
        customer_id: 'cus_1',
        card_brand: 'visa',
        card_country: 'MY',
        card_last4: '4242',
        card_exp_month: '12',
        card_exp_year: '2030',
        ...override,
      }
      const { checksum, ...signed } = fields
      return {
        fields: {
          ...signed,
          checksum: checksum ?? signFixed(opts.secretKey, signed, RECURRING_CHARGE_FIELDS),
        },
        rawBody: '',
        headers: {},
      }
    },
    recurringReturn(override = {}) {
      const fields: Record<string, string> = {
        recurring_type: 'subscription',
        status: 'active',
        customer_id: 'cus_1',
        subscription_id: 'sub_1',
        installment_id: '',
        transaction_id: 'trx_rc_1',
        exchange_reference_number: '1-rc-1',
        exchange_transaction_id: 'CCrc1',
        currency: 'MYR',
        amount: '25.00',
        transaction_status: '3',
        transaction_status_description: 'Approved',
        ...override,
      }
      const { checksum, ...signed } = fields
      return {
        fields: {
          ...signed,
          checksum: checksum ?? signFixed(opts.secretKey, signed, RECURRING_RETURN_FIELDS),
        },
        rawBody: '',
        headers: {},
      }
    },
    tamper: (cb) => ({ ...cb, fields: { ...cb.fields, checksum: flip(cb.fields.checksum ?? '') } }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
