/**
 * A fake Stripe API (Checkout Sessions only), built from the official docs in `gateways/stripe/spec.md` and checked
 * against test mode 27 Oct 2026 (Malaysian account): the shapes it serves matched; one completed event per paid
 * session, FPX included; a failed FPX payment sends no Checkout event. Change this file first when Stripe changes.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - auth: `Authorization: Bearer <key>` or Basic `<key>:` with the configured `sk_test_` key, else 401 [§1];
 * - bodies are form-encoded with bracket keys; responses JSON; errors `{ error: { type, message, code? } }` [§1];
 * - `Stripe-Version` is REQUIRED here. Real Stripe falls back to the account default [§1]; the fake is stricter on
 *   purpose so a test proves the adapter always pins the version;
 * - under `2026-09-30.endive`, any `payment_method_types` key → 400, as the endive changelog states [§2.3];
 * - `expires_at` must be 30 min to 24 h after creation; default 24 h [§2.1]; minimum charge 200 sen (MYR) [§5];
 * - `Idempotency-Key`: same key + same params → the same session; same key + other params → error [§2.5];
 * - webhooks: `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(whsec, "<t>.<raw body>")>` [§4].
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

export const ENDIVE = '2026-09-30.endive'

type Session = Record<string, unknown> & { id: string }

export interface FakeStripe extends FakeGateway {
  requests: {
    method: string
    path: string
    /** The form body as received: bracket keys left as they are, repeated keys (`a[]`) joined with `,`. */
    body: Record<string, string>
    /** Every key in body order, repeated keys included. */
    keys: string[]
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record of a session (what `GET /v1/checkout/sessions/{id}` answers). */
  session(id: string): Session | undefined
}

/** `t=<t>,v1=<hex>` exactly as Stripe builds it: HMAC-SHA256 over `${t}.${rawBody}`, key = the full `whsec_…` string. */
export function stripeSignature(webhookSecret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`, 'utf8').digest('hex')}`
}

const randomId = (prefix: string) => `${prefix}${randomBytes(12).toString('hex')}`

export async function startFakeStripe(opts: {
  secretKey: string
  webhookSecret: string
}): Promise<FakeStripe> {
  const sessions = new Map<string, Session>()
  const versions = new Map<string, string>()
  const idempotent = new Map<string, { params: string; status: number; body: unknown }>()
  const requests: FakeStripe['requests'] = []
  const now = () => Math.floor(Date.now() / 1000)

  const authorised = (header: string | undefined) => {
    if (!header) return false
    if (header === `Bearer ${opts.secretKey}`) return true
    const basic = /^Basic (.+)$/.exec(header)?.[1]
    return !!basic && Buffer.from(basic, 'base64').toString('utf8') === `${opts.secretKey}:`
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const form = new URLSearchParams(raw)
      const keys = [...form.keys()]
      const body: Record<string, string> = {}
      for (const k of new Set(keys)) body[k] = form.getAll(k).join(',')
      const path = (req.url ?? '').split('?')[0] ?? ''
      requests.push({ method: req.method ?? '', path, body, keys, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const fail = (status: number, type: string, message: string, extra: Record<string, string> = {}) =>
        send(status, { error: { type, message, ...extra } })

      if (!authorised(req.headers.authorization)) {
        return fail(401, 'invalid_request_error', 'Invalid API Key provided.')
      }
      const version = req.headers['stripe-version']
      if (typeof version !== 'string' || !version) {
        return fail(
          400,
          'invalid_request_error',
          'fake Stripe: send a Stripe-Version header (pin the API version).',
        )
      }

      if (req.method === 'POST' && path === '/v1/checkout/sessions') {
        if (version === ENDIVE && keys.some((k) => k.startsWith('payment_method_types'))) {
          return fail(
            400,
            'invalid_request_error',
            'You can no longer pass `payment_method_types` when you create a Checkout Session.',
            { param: 'payment_method_types' },
          )
        }
        const key = req.headers['idempotency-key']
        const idemKey = typeof key === 'string' && key ? key : ''
        if (idemKey.length > 255) return fail(400, 'invalid_request_error', 'Idempotency-Key is too long.')
        const params = JSON.stringify(keys.map((k) => [k, form.getAll(k)]))
        const saved = idemKey ? idempotent.get(idemKey) : undefined
        if (saved) {
          if (saved.params !== params) {
            return fail(
              400,
              'idempotency_error',
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            )
          }
          return send(saved.status, saved.body)
        }
        const result = create(body, version)
        // Validation failures are not saved (spec §2.5), so the caller can fix and retry with the same key.
        if (idemKey && result.status === 200)
          idempotent.set(idemKey, { params, status: result.status, body: result.body })
        return send(result.status, result.body)
      }

      const get = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/.exec(path)
      if (req.method === 'GET' && get) {
        const s = sessions.get(get[1] ?? '')
        if (!s) return missing(get[1] ?? '')
        return send(200, s)
      }
      const expire = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)\/expire$/.exec(path)
      if (req.method === 'POST' && expire) {
        const s = sessions.get(expire[1] ?? '')
        if (!s) return missing(expire[1] ?? '')
        if (s.status !== 'open') {
          return fail(
            400,
            'invalid_request_error',
            `Only Checkout Sessions with a status of open can be expired.`,
          )
        }
        s.status = 'expired'
        s.url = null
        return send(200, s)
      }
      return fail(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${path}).`)

      function missing(id: string) {
        return fail(404, 'invalid_request_error', `No such checkout.session: '${id}'`, {
          code: 'resource_missing',
        })
      }
    })
  })

  function create(body: Record<string, string>, version: string): { status: number; body: unknown } {
    const bad = (message: string, param?: string) => ({
      status: 400,
      body: { error: { type: 'invalid_request_error', message, ...(param ? { param } : {}) } },
    })
    if (body.mode !== 'payment') return bad('Missing or unsupported mode.', 'mode')
    const currency = body['line_items[0][price_data][currency]']
    const unit = body['line_items[0][price_data][unit_amount]'] ?? ''
    const name = body['line_items[0][price_data][product_data][name]']
    const quantity = body['line_items[0][quantity]'] ?? ''
    if (currency !== 'myr')
      return bad('This fake only speaks MYR (myr).', 'line_items[0][price_data][currency]')
    if (!/^\d+$/.test(unit))
      return bad('Invalid integer: unit_amount', 'line_items[0][price_data][unit_amount]')
    if (!name)
      return bad(
        'Missing required param: product_data[name].',
        'line_items[0][price_data][product_data][name]',
      )
    if (!/^[1-9]\d*$/.test(quantity)) return bad('Invalid integer: quantity', 'line_items[0][quantity]')
    if (!body.success_url) return bad('Missing required param: success_url.', 'success_url')
    const amountTotal = Number(unit) * Number(quantity)
    if (amountTotal < 200)
      return bad('The Checkout Session total must be at least RM2.00 (200 sen).', 'line_items')
    const created = now()
    let expiresAt = created + 86_400
    if (body.expires_at !== undefined) {
      const e = Number(body.expires_at)
      if (!Number.isInteger(e) || e - created < 1800 || e - created > 86_400) {
        return bad('expires_at must be between 30 minutes and 24 hours after creation.', 'expires_at')
      }
      expiresAt = e
    }
    if ((body.client_reference_id ?? '').length > 200) return bad('client_reference_id is too long.')
    const allowed = body['allowed_payment_method_types[]']?.split(',')
    const legacy = body['payment_method_types[]']?.split(',')
    const id = randomId('cs_test_')
    const session: Session = {
      id,
      object: 'checkout.session',
      amount_total: amountTotal,
      cancel_url: body.cancel_url ?? null,
      client_reference_id: body.client_reference_id ?? null,
      created,
      currency: 'myr',
      customer_email: body.customer_email ?? null,
      expires_at: expiresAt,
      livemode: false,
      metadata: {},
      mode: 'payment',
      payment_intent: null,
      payment_method_types: allowed ?? legacy ?? ['card'],
      payment_status: 'unpaid',
      status: 'open',
      success_url: body.success_url,
      ui_mode: 'hosted_page',
      url: `https://checkout.stripe.com/c/pay/${id}#fake`,
    }
    sessions.set(id, session)
    versions.set(id, version)
    return { status: 200, body: session }
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const session = (id: string) => {
    const s = sessions.get(id)
    if (!s) throw new Error(`fake Stripe: no checkout session ${id}`)
    return s
  }

  return {
    url,
    requests,
    session: (id) => sessions.get(id),
    markPaid(id) {
      const s = session(id)
      s.status = 'complete'
      s.payment_status = 'paid'
      s.payment_intent ??= randomId('pi_')
      s.url = null
    },
    /**
     * A `checkout.session.completed` event claiming payment (even before `markPaid`; the fake's record stays unpaid).
     * `override` changes fields of `data.object` before signing; the key `type` changes the event type instead.
     */
    callbackFor(id, override = {}) {
      const { type, ...fields } = override
      const s = session(id)
      const event = {
        id: randomId('evt_'),
        object: 'event',
        api_version: versions.get(id) ?? ENDIVE,
        created: now(),
        data: {
          object: {
            ...s,
            status: 'complete',
            payment_status: 'paid',
            payment_intent: s.payment_intent ?? randomId('pi_'),
            url: null,
            ...fields,
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: type ?? 'checkout.session.completed',
      }
      // Indented, so a handler that re-serialises the parsed JSON gets different bytes and the signature fails.
      const rawBody = JSON.stringify(event, null, 2)
      return {
        fields: {},
        rawBody,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignature(opts.webhookSecret, rawBody, now()),
        },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: {
        ...cb.headers,
        'stripe-signature': (cb.headers['stripe-signature'] ?? '').replace(
          /v1=([0-9a-f]+)/,
          (_m, hex: string) => `v1=${flip(hex)}`,
        ),
      },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
