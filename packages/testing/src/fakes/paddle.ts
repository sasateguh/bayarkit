/**
 * A fake Paddle Billing API (one-time transactions and refund adjustments), built from the official docs in
 * `gateways/paddle/spec.md`. Not yet checked against the sandbox: every rule below is the docs' word until a sandbox
 * run says otherwise. Change this file first when Paddle changes.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - auth: `Authorization: Bearer <key>`; missing → 403 `authentication_missing`, not Bearer → 403
 *   `authentication_malformed`, another key → 403 `invalid_token` [§1, errors index];
 * - `Paddle-Version` is REQUIRED and must be `1`. Real Paddle falls back to the account default [§1]; the fake is
 *   stricter on purpose so a test proves the adapter always pins the version;
 * - JSON in and out, entities under `data`, errors `{ error: { type, code, detail, documentation_url } }` [§1, §7];
 * - create: one or more non-catalog prices, `unit_price.amount` a STRING of an integer in the lowest denomination, a
 *   currency from the 33 Paddle takes (no MYR), `description` 2–500, `product.tax_category` from the documented set,
 *   `custom_data` an object with at least one key or null [§2.1]; the default payment link must be set and a passed
 *   `checkout.url` must be on an approved domain [§2.2]; documented minimum charges [§6];
 * - tax (merchant of record) [§2.3]: a `tax_mode: internal` price is charged as asked. Any other mode gets a 10% tax on
 *   top here. The rate is the fake's own choice: real tax depends on the buyer's country, so the point is only that
 *   an app cannot know the total in advance unless it sends `internal`;
 * - a new transaction without a customer is `draft`; `markPaid` = `completed` with one captured payment; a declined
 *   card adds an `error` payment and leaves the status alone [§3];
 * - refunds: `POST /adjustments` with `action: refund`, only on `completed`, full or per-item partial, never above
 *   what remains, not while another refund awaits approval; each starts `pending_approval` and `approveRefunds()`
 *   plays the sandbox's approval run. Adjusted totals drop on approval (UNCONFIRMED: maybe on create) [§5];
 * - webhooks: `Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256(secret, "<ts>:<raw body>")>`, one `h1` per secret [§4].
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

export const PADDLE_VERSION = '1'

/** The payment currencies Paddle lists [§6]. */
const CURRENCIES = new Set(
  'USD GBP EUR ARS AUD BRL CAD CHF CLP CNY COP CZK DKK HKD HUF ILS INR JPY KRW MXN NOK NZD PEN PLN RUB SEK SGD THB TRY TWD UAH VND ZAR'.split(
    ' ',
  ),
)
/** Minimum charges the docs state, lowest denomination [§6]. Other currencies are not checked here. */
const MINIMUMS: Record<string, number> = { USD: 70, EUR: 65, GBP: 55, SGD: 90, JPY: 100 }
const TAX_CATEGORIES = new Set([
  'digital-goods',
  'ebooks',
  'implementation-services',
  'professional-services',
  'saas',
  'software-programming-services',
  'standard',
  'training-services',
  'website-hosting',
])
const TAX_MODES = new Set(['account_setting', 'external', 'internal', 'location'])
const FAKE_TAX_RATE = 0.1

type Body = Record<string, unknown>
const obj = (v: unknown): Body => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {})

type Amounts = Record<
  'subtotal' | 'discount' | 'tax' | 'total' | 'credit' | 'balance' | 'grand_total',
  string
> & {
  fee: string | null
  earnings: string | null
  currency_code: string
}
interface LineItem extends Body {
  id: string
  totals: { subtotal: string; discount: string; tax: string; total: string }
}
export interface PaddleTransaction extends Body {
  id: string
  status: string
  currency_code: string
  customer_id: string | null
  billed_at: string | null
  updated_at: string
  details: {
    tax_rates_used: unknown[]
    totals: Amounts
    adjusted_totals: Amounts
    payout_totals: null
    line_items: LineItem[]
  }
  payments: Body[]
  checkout: { url: string }
}
export interface PaddleAdjustment extends Body {
  id: string
  transaction_id: string
  status: 'pending_approval' | 'approved' | 'rejected' | 'reversed'
  items: { item_id: string; type: 'full' | 'partial'; amount: string }[]
  totals: Record<'subtotal' | 'tax' | 'total' | 'fee' | 'earnings' | 'currency_code', string>
  updated_at: string
}

export interface FakePaddle extends FakeGateway {
  requests: {
    method: string
    path: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record of a transaction (what `GET /transactions/{id}` answers under `data`). */
  transaction(id: string): PaddleTransaction | undefined
  adjustment(id: string): PaddleAdjustment | undefined
  /** A declined card: an `error` payment attempt, status unchanged (one-time checkout) [§3]. */
  decline(id: string): void
  /** The sandbox's periodic approval run: every `pending_approval` refund becomes `approved` [§5]. */
  approveRefunds(): void
}

/**
 * `ts=<ts>;h1=<hex>` exactly as Paddle builds it: HMAC-SHA256 over `${ts}:${rawBody}`, keyed with the destination's
 * secret. Pass several secrets to get one `h1` each, as during a secret rotation.
 */
export function paddleSignature(secret: string | string[], rawBody: string, ts: number): string {
  const h1 = (Array.isArray(secret) ? secret : [secret]).map(
    (s) => `;h1=${createHmac('sha256', s).update(`${ts}:${rawBody}`, 'utf8').digest('hex')}`,
  )
  return `ts=${ts}${h1.join('')}`
}

const paddleId = (prefix: string) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return `${prefix}_${[...randomBytes(26)].map((b) => chars[b % chars.length]).join('')}`
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail)
  }
}
const invalid = (detail: string) => new Refused(400, 'invalid_field', detail)

export async function startFakePaddle(opts: {
  apiKey: string
  webhookSecret: string
  /** Paddle > Checkout > Default payment link. Empty = not set, so every create fails as the docs say [§2.2]. */
  defaultPaymentLink?: string
  /** Approved checkout domains besides the default link's own. */
  approvedDomains?: string[]
}): Promise<FakePaddle> {
  const defaultLink = opts.defaultPaymentLink ?? 'https://shop.example/pay'
  const approved = new Set(opts.approvedDomains ?? [])
  if (defaultLink) approved.add(new URL(defaultLink).host)
  const transactions = new Map<string, PaddleTransaction>()
  const adjustments = new Map<string, PaddleAdjustment>()
  const requests: FakePaddle['requests'] = []
  const iso = () => new Date().toISOString()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const fail = (status: number, code: string, detail: string) =>
        send(status, {
          error: {
            type: 'request_error',
            code,
            detail,
            documentation_url: `https://developer.paddle.com/errors/shared/${code}`,
          },
          meta: { request_id: randomBytes(8).toString('hex') },
        })
      let body: unknown = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = undefined
        }
      }
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })

      const auth = req.headers.authorization
      if (!auth) return fail(403, 'authentication_missing', 'No Authorization header detected.')
      if (!/^Bearer \S+$/.test(auth))
        return fail(403, 'authentication_malformed', 'Authorization header invalid.')
      if (auth !== `Bearer ${opts.apiKey}`) return fail(403, 'invalid_token', 'The API key is not valid.')
      if (req.headers['paddle-version'] !== PADDLE_VERSION) {
        return fail(
          400,
          'bad_request',
          `fake Paddle: send Paddle-Version: ${PADDLE_VERSION} (pin the API version).`,
        )
      }
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return fail(415, 'unsupported_media_type', 'The request has an invalid Content-Type header.')
        }
        if (body === undefined || typeof body !== 'object' || body === null) {
          return fail(400, 'invalid_json', 'The request is not valid JSON.')
        }
      }

      try {
        if (req.method === 'POST' && path === '/transactions') {
          return send(201, {
            data: create(body as Body),
            meta: { request_id: randomBytes(8).toString('hex') },
          })
        }
        const get = /^\/transactions\/([A-Za-z0-9_]+)$/.exec(path)
        if (req.method === 'GET' && get) return send(200, { data: find(get[1] ?? '') })
        if (req.method === 'POST' && path === '/adjustments') {
          return send(201, {
            data: refund(body as Body),
            meta: { request_id: randomBytes(8).toString('hex') },
          })
        }
        return fail(404, 'not_found', `Unrecognized request URL (${req.method}: ${path}).`)
      } catch (e) {
        if (e instanceof Refused) return fail(e.status, e.code, e.message)
        throw e
      }
    })
  })

  function find(id: string): PaddleTransaction {
    const t = transactions.get(id)
    if (!t) throw new Refused(404, 'not_found', `Entity ${id} not found.`)
    return t
  }

  function create(body: Body): PaddleTransaction {
    if (!defaultLink) {
      throw new Refused(400, 'transaction_default_checkout_url_not_set', 'Set a default payment link first.')
    }
    const items = body.items
    if (!Array.isArray(items) || items.length < 1 || items.length > 100)
      throw invalid('items: 1 to 100 entries.')
    let currency = ''
    const lineItems: LineItem[] = []
    let subtotal = 0
    let tax = 0
    for (const [i, item] of items.entries()) {
      const p = obj(obj(item).price)
      if (!Object.keys(p).length) throw invalid(`items[${i}].price is required (non-catalog price).`)
      const q = obj(item).quantity
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1)
        throw invalid(`items[${i}].quantity must be a positive integer.`)
      const desc = p.description
      if (typeof desc !== 'string' || desc.length < 2 || desc.length > 500) {
        throw invalid(`items[${i}].price.description: 2 to 500 characters.`)
      }
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 150)) {
        throw invalid(`items[${i}].price.name: 1 to 150 characters.`)
      }
      const amount = obj(p.unit_price).amount
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
        throw invalid(
          `items[${i}].price.unit_price.amount must be a string of an integer (lowest denomination).`,
        )
      }
      const code = obj(p.unit_price).currency_code
      if (typeof code !== 'string' || !CURRENCIES.has(code)) {
        throw invalid(`items[${i}].price.unit_price.currency_code is not a supported currency.`)
      }
      if (currency && code !== currency) throw invalid('All items must use the same currency.')
      currency = code
      const mode = p.tax_mode ?? 'account_setting'
      if (typeof mode !== 'string' || !TAX_MODES.has(mode))
        throw invalid(`items[${i}].price.tax_mode is not valid.`)
      const product = obj(p.product)
      if (typeof product.name !== 'string' || product.name.length < 1 || product.name.length > 200) {
        throw invalid(`items[${i}].price.product.name: 1 to 200 characters.`)
      }
      if (typeof product.tax_category !== 'string' || !TAX_CATEGORIES.has(product.tax_category)) {
        throw invalid(`items[${i}].price.product.tax_category is not valid.`)
      }
      const lineSub = Number(amount) * q
      const lineTax = mode === 'internal' ? 0 : Math.round(lineSub * FAKE_TAX_RATE)
      subtotal += lineSub
      tax += lineTax
      const total = String(lineSub + lineTax)
      lineItems.push({
        id: paddleId('txnitm'),
        price_id: paddleId('pri'),
        quantity: q,
        tax_rate: mode === 'internal' ? '0' : String(FAKE_TAX_RATE),
        unit_totals: { subtotal: amount, discount: '0', tax: '0', total: amount },
        totals: { subtotal: String(lineSub), discount: '0', tax: String(lineTax), total },
        product: { id: paddleId('pro'), name: product.name, tax_category: product.tax_category },
      })
    }
    const cd = body.custom_data
    if (
      cd !== undefined &&
      cd !== null &&
      (typeof cd !== 'object' || Array.isArray(cd) || !Object.keys(cd).length)
    ) {
      throw invalid('custom_data must be an object with at least one key, or null.')
    }
    const grand = subtotal + tax
    const min = MINIMUMS[currency]
    if (min !== undefined && grand < min) {
      throw new Refused(
        400,
        'transaction_balance_less_than_charge_limit',
        `The balance is below ${min} ${currency}.`,
      )
    }
    let base = defaultLink
    const passed = obj(body.checkout).url
    if (passed !== undefined && passed !== null) {
      let host = ''
      try {
        host = new URL(String(passed)).host
      } catch {
        throw invalid('checkout.url must be a URL.')
      }
      if (!approved.has(host)) {
        throw new Refused(400, 'transaction_checkout_url_domain_is_not_approved', `${host} is not approved.`)
      }
      base = String(passed)
    }
    const id = paddleId('txn')
    const totals: Amounts = {
      subtotal: String(subtotal),
      discount: '0',
      tax: String(tax),
      total: String(grand),
      credit: '0',
      balance: String(grand),
      grand_total: String(grand),
      fee: null,
      earnings: null,
      currency_code: currency,
    }
    const now = iso()
    const txn: PaddleTransaction = {
      id,
      status: 'draft',
      customer_id: null,
      address_id: null,
      business_id: null,
      custom_data: cd ?? null,
      origin: 'api',
      collection_mode: body.collection_mode ?? 'automatic',
      subscription_id: null,
      invoice_id: null,
      invoice_number: null,
      billing_details: null,
      billing_period: null,
      currency_code: currency,
      discount_id: null,
      created_at: now,
      updated_at: now,
      billed_at: null,
      items,
      details: {
        tax_rates_used: [],
        totals,
        adjusted_totals: { ...totals },
        payout_totals: null,
        line_items: lineItems,
      },
      payments: [],
      checkout: { url: `${base}${base.includes('?') ? '&' : '?'}_ptxn=${id}` },
    }
    transactions.set(id, txn)
    return txn
  }

  /** What is still refundable per line item: its total minus every refund that is pending or approved. */
  function remaining(t: PaddleTransaction): Map<string, number> {
    const left = new Map<string, number>(t.details.line_items.map((li) => [li.id, Number(li.totals.total)]))
    for (const a of adjustments.values()) {
      if (a.transaction_id !== t.id || (a.status !== 'pending_approval' && a.status !== 'approved')) continue
      for (const it of a.items) left.set(it.item_id, (left.get(it.item_id) ?? 0) - Number(it.amount))
    }
    return left
  }

  function refund(body: Body): PaddleAdjustment {
    if (body.action !== 'refund') throw invalid('action: this fake handles refunds only.')
    if (typeof body.reason !== 'string' || !body.reason.trim()) throw invalid('reason is required.')
    if (typeof body.transaction_id !== 'string') throw invalid('transaction_id is required.')
    const t = find(body.transaction_id)
    const type = body.type ?? 'partial'
    if (type !== 'full' && type !== 'partial') throw invalid('type must be full or partial.')
    if (body.tax_mode !== undefined && type === 'full') {
      throw new Refused(400, 'adjustment_tax_mode_not_allowed', 'tax_mode is for partial refunds only.')
    }
    if (t.status !== 'completed') {
      throw new Refused(
        400,
        'adjustment_transaction_invalid_status_for_refund',
        `Transaction is ${t.status}.`,
      )
    }
    const pending = [...adjustments.values()].some(
      (a) => a.transaction_id === t.id && a.status === 'pending_approval',
    )
    if (pending) throw new Refused(400, 'adjustment_pending_refund_request', 'A refund is pending approval.')
    const left = remaining(t)
    let items: PaddleAdjustment['items']
    if (type === 'full') {
      items = [...left]
        .filter(([, n]) => n > 0)
        .map(([item_id, n]) => ({ item_id, type: 'full', amount: String(n) }))
      if (!items.length)
        throw new Refused(400, 'adjustment_total_amount_above_remaining_allowed', 'Nothing left.')
    } else {
      if (!Array.isArray(body.items) || !body.items.length)
        throw invalid('items are required for a partial refund.')
      items = []
      for (const entry of body.items) {
        const it = obj(entry)
        const itemId = String(it.item_id)
        const have = left.get(itemId)
        if (have === undefined) {
          throw new Refused(
            400,
            'adjustment_transaction_item_invalid',
            `Item ${itemId} is not on the transaction.`,
          )
        }
        if (it.type === 'full') {
          items.push({ item_id: itemId, type: 'full', amount: String(have) })
          continue
        }
        if (it.type !== 'partial' || typeof it.amount !== 'string' || !/^\d+$/.test(it.amount)) {
          throw invalid('items[].amount must be a string of an integer (lowest denomination).')
        }
        const n = Number(it.amount)
        if (n === 0) throw new Refused(400, 'adjustment_amount_cannot_be_zero', 'The amount cannot be zero.')
        if (n > have) {
          throw new Refused(
            400,
            'adjustment_amount_above_remaining_allowed',
            `Only ${have} remains on the item.`,
          )
        }
        items.push({ item_id: itemId, type: 'partial', amount: it.amount })
      }
    }
    const total = items.reduce((s, it) => s + Number(it.amount), 0)
    const now = iso()
    const adj: PaddleAdjustment = {
      id: paddleId('adj'),
      action: 'refund',
      type,
      transaction_id: t.id,
      subscription_id: null,
      customer_id: t.customer_id,
      reason: body.reason,
      credit_applied_to_balance: null,
      currency_code: t.currency_code,
      status: 'pending_approval',
      items,
      totals: {
        subtotal: String(total),
        tax: '0',
        total: String(total),
        fee: '0',
        earnings: '0',
        currency_code: t.currency_code,
      },
      payout_totals: null,
      tax_rates_used: [],
      created_at: now,
      updated_at: now,
    }
    adjustments.set(adj.id, adj)
    return adj
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const known = (id: string) => {
    const t = transactions.get(id)
    if (!t) throw new Error(`fake Paddle: no transaction ${id}`)
    return t
  }

  return {
    url,
    requests,
    transaction: (id) => transactions.get(id),
    adjustment: (id) => adjustments.get(id),
    markPaid(id) {
      const t = known(id)
      const now = iso()
      t.status = 'completed'
      t.billed_at ??= now
      t.updated_at = now
      t.details.totals.balance = '0'
      t.details.adjusted_totals.balance = '0'
      t.payments.unshift({
        payment_attempt_id: randomBytes(16).toString('hex'),
        stored_payment_method_id: randomBytes(16).toString('hex'),
        amount: t.details.totals.grand_total,
        status: 'captured',
        error_code: null,
        method_details: { type: 'card', card: { type: 'visa', last4: '4242' } },
        created_at: now,
        captured_at: now,
      })
    },
    decline(id) {
      const t = known(id)
      t.payments.unshift({
        payment_attempt_id: randomBytes(16).toString('hex'),
        stored_payment_method_id: null,
        amount: t.details.totals.grand_total,
        status: 'error',
        error_code: 'declined',
        method_details: { type: 'card', card: { type: 'visa', last4: '0002' } },
        created_at: iso(),
        captured_at: null,
      })
    },
    approveRefunds() {
      for (const a of adjustments.values()) {
        if (a.status !== 'pending_approval') continue
        a.status = 'approved'
        a.updated_at = iso()
        const t = transactions.get(a.transaction_id)
        if (!t) continue
        const adjusted = t.details.adjusted_totals
        const refunded = Number(a.totals.total)
        for (const k of ['subtotal', 'total', 'grand_total'] as const)
          adjusted[k] = String(Number(adjusted[k]) - refunded)
      }
    },
    /**
     * A `transaction.completed` notification claiming payment (even before `markPaid`; the fake's record stays
     * unpaid). `override` changes fields of `data` before signing; the key `event_type` changes the event instead.
     */
    callbackFor(id, override = {}) {
      const { event_type, ...fields } = override
      const t = known(id)
      const event = {
        event_id: paddleId('evt'),
        event_type: event_type ?? 'transaction.completed',
        occurred_at: iso(),
        notification_id: paddleId('ntf'),
        data: { ...t, status: 'completed', ...fields },
      }
      // Indented, so a handler that re-serialises the parsed JSON gets different bytes and the signature fails.
      const rawBody = JSON.stringify(event, null, 2)
      return {
        fields: {},
        rawBody,
        headers: {
          'content-type': 'application/json',
          'paddle-signature': paddleSignature(opts.webhookSecret, rawBody, Math.floor(Date.now() / 1000)),
        },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: {
        ...cb.headers,
        'paddle-signature': (cb.headers['paddle-signature'] ?? '').replace(
          /h1=([0-9a-f]+)/,
          (_m, hex: string) => `h1=${flip(hex)}`,
        ),
      },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
