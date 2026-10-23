/**
 * A fake CHIP Collect API, built from the official OpenAPI (docs.chip-in.asia/openapi/chip-collect.yaml, read
 * 2026-10-23) and `gateways/chip/spec.md`. NOT yet measured against CHIP's test mode: when someone does, change this
 * file first so it answers like the real thing, then the adapter.
 *
 * - base path `/api/v1`, plural paths with a trailing slash, `Authorization: Bearer <secret key>`;
 * - 401 body = the shape observed live on gate.chip-in.asia (`__all__` is an ARRAY there); other errors use the
 *   OpenAPI 400 example shape (`__all__` is an OBJECT). Field-level error shapes are not documented, so every
 *   validation error here uses that one example shape;
 * - `success_callback` with an explicit port (even `:443`) → `webhooks_callback_port`; non-http(s) →
 *   `webhooks_callback_scheme`; URL fields nested inside `purchase` are ignored silently (docs /overview/callbacks);
 * - callbacks: the Purchase JSON plus `event_type`, signed in `X-Signature` = base64 RSA PKCS#1 v1.5 over SHA-256 of
 *   the raw body; `GET /public_key/` answers the PEM as a JSON-encoded string;
 * - the fee on a paid purchase is illustrative only (CHIP's fees are per merchant and not in the OpenAPI).
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

const METHODS = new Set([
  'fpx',
  'fpx_b2b1',
  'crypto_coin',
  'dnqr',
  'duitnow_qr',
  'maestro',
  'mastercard',
  'mpgs_apple_pay',
  'mpgs_google_pay',
  'razer_atome',
  'razer_grabpay',
  'razer_maybankqr',
  'razer_shopeepay',
  'razer_tng',
  'shopee_pay',
  'visa',
])

type Json = Record<string, unknown>

export interface FakeChip extends FakeGateway {
  /** The PEM public key that signs this fake's callbacks (what `GET /public_key/` returns, JSON-decoded). */
  publicKey: string
  requests: {
    method: string
    path: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
}

/** True when the URL's authority spells out a port (`URL` normalises `:443` away, so the text is checked). */
const explicitPort = (url: string) => /:\d*$/.test(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '')

export async function startFakeChip(opts: {
  secretKey: string
  brandId: string
  /** `is_test` on every purchase; CHIP sets it from the key's mode. Default true (test keys). */
  isTest?: boolean
}): Promise<FakeChip> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const purchases = new Map<string, Json>()
  const requests: FakeChip['requests'] = []
  let n = 0
  const now = () => Math.floor(Date.now() / 1000)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      let body: Json = {}
      try {
        const parsed = raw ? JSON.parse(raw) : {}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
      } catch {}
      const path = req.url ?? ''
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const bad = (code: string, message: string) => send(400, { __all__: { message, code } })

      const auth = req.headers.authorization
      if (!auth)
        return send(401, {
          __all__: [{ message: 'Authorization header missing', code: 'authentication_failed' }],
        })
      if (auth !== `Bearer ${opts.secretKey}`)
        return send(401, { __all__: [{ message: 'Incorrect secret_key', code: 'authentication_failed' }] })

      if (req.method === 'POST' && path === '/api/v1/purchases/') {
        if (body.brand_id !== opts.brandId) return bad('invalid', 'brand_id: invalid brand')
        const client = body.client as Json | undefined
        if (!client || typeof client.email !== 'string' || !client.email)
          return bad('required', 'client.email: this field is required')
        const details = (body.purchase ?? {}) as Json
        const products = details.products
        if (!Array.isArray(products) || products.length === 0)
          return bad('required', 'purchase.products: at least one product is required')
        for (const p of products as Json[]) {
          if (typeof p?.name !== 'string' || !p.name || p.name.length > 256)
            return bad('invalid', 'purchase.products.name: required, at most 256 characters')
          if (!Number.isInteger(p.price) || (p.price as number) < 0)
            return bad('invalid', 'purchase.products.price: integer in minor units, at least 0')
        }
        const cb = body.success_callback
        if (cb != null && cb !== '') {
          if (typeof cb !== 'string' || !/^https?:\/\//i.test(cb))
            return bad('webhooks_callback_scheme', 'success_callback: only http and https are supported')
          if (explicitPort(cb))
            return bad('webhooks_callback_port', 'success_callback: the URL must not contain a port')
        }
        const wl = body.payment_method_whitelist
        if (
          wl !== undefined &&
          (!Array.isArray(wl) || wl.length === 0 || wl.some((m) => !METHODS.has(String(m))))
        )
          return bad('invalid', 'payment_method_whitelist: unknown or empty')
        if (body.due != null && !Number.isInteger(body.due))
          return bad('invalid', 'due: must be a Unix timestamp')
        const id = randomUUID()
        n += 1
        const total = (products as Json[]).reduce(
          (s, p) => s + (p.price as number) * Number(p.quantity ?? 1) - Number(p.discount ?? 0),
          0,
        )
        const created = now()
        const purchase: Json = {
          id,
          type: 'purchase',
          status: 'created',
          is_test: opts.isTest ?? true,
          brand_id: opts.brandId,
          reference: typeof body.reference === 'string' ? body.reference : '',
          reference_generated: `CH${String(n).padStart(4, '0')}`,
          due: body.due ?? null,
          created_on: created,
          updated_on: created,
          payment_method_whitelist: wl ?? null,
          // Only top-level URL fields count; nested ones are ignored silently (docs /overview/callbacks).
          success_redirect: body.success_redirect ?? '',
          failure_redirect: body.failure_redirect ?? '',
          cancel_redirect: body.cancel_redirect ?? '',
          success_callback: cb ?? '',
          checkout_url: `${url}/p/${id}/`,
          direct_post_url: null,
          status_history: [{ status: 'created', timestamp: created }],
          client: { email: client.email, full_name: client.full_name ?? '', phone: client.phone ?? '' },
          purchase: {
            currency: typeof details.currency === 'string' ? details.currency : 'MYR',
            due_strict: details.due_strict === true,
            total,
            products: (products as Json[]).map((p) => ({
              name: p.name,
              price: p.price,
              quantity: Number(p.quantity ?? 1).toFixed(4),
              discount: p.discount ?? 0,
              tax_percent: '0.00',
              category: '',
              total_price_override: null,
            })),
          },
          payment: null,
          transaction_data: { payment_method: '', flow: 'payform', attempts: [] },
        }
        purchases.set(id, purchase)
        return send(201, purchase)
      }
      const one = /^\/api\/v1\/purchases\/([A-Za-z0-9-]+)\/$/.exec(path)
      if (req.method === 'GET' && one) {
        const p = purchases.get(one[1] ?? '')
        if (!p) return send(404, { __all__: { message: 'No such object', code: 'not_found' } })
        return send(200, p)
      }
      if (req.method === 'GET' && path === '/api/v1/public_key/') return send(200, pem)
      send(404, { __all__: { message: 'No such object', code: 'not_found' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const purchase = (id: string) => {
    const p = purchases.get(id)
    if (!p) throw new Error(`fake CHIP: no purchase ${id}`)
    return p
  }
  const paymentFor = (p: Json, paidOn: number): Json => {
    const total = (p.purchase as { total: number }).total
    const fee = Math.min(100, total) // illustrative
    return {
      is_outgoing: false,
      payment_type: 'purchase',
      amount: total,
      currency: (p.purchase as { currency: string }).currency,
      net_amount: total - fee,
      fee_amount: fee,
      pending_amount: 0,
      pending_unfreeze_on: null,
      description: '',
      paid_on: paidOn,
      remote_paid_on: paidOn,
    }
  }

  return {
    url: `${url}/api/v1`,
    publicKey: pem,
    requests,
    markPaid(id) {
      const p = purchase(id)
      const t = now()
      p.status = 'paid'
      p.payment = paymentFor(p, t)
      p.updated_on = t
      ;(p.transaction_data as Json).payment_method = 'fpx'
      ;(p.status_history as Json[]).push({ status: 'paid', timestamp: t })
    },
    callbackFor(id, override = {}) {
      const p = purchase(id)
      // A callback claims success even before markPaid (replay / leaked key); the fake's own record stays unpaid.
      const payload: Json = {
        ...structuredClone(p),
        status: 'paid',
        payment: p.payment ?? paymentFor(p, now()),
        event_type: 'purchase.paid',
        ...override,
      }
      const rawBody = JSON.stringify(payload)
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v)
      }
      const signature = sign('sha256', Buffer.from(rawBody), privateKey).toString('base64')
      return {
        fields,
        rawBody,
        headers: { 'content-type': 'application/json', 'x-signature': signature },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: { ...cb.headers, 'x-signature': flip(cb.headers['x-signature'] ?? '') },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
