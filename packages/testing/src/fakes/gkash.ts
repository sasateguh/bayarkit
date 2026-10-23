/**
 * A fake Gkash API (host-to-host checkout `POST /api/payment/form` + `POST /api/payment/query`), built from the
 * official documentation (doc.gkash.my), the official WooCommerce plugin and the gkashmy SDKs — see
 * gateways/gkash/spec.md. NOT yet measured against the staging host (api-staging.pay.asia): when someone does, change
 * this file first so it answers like the real thing, then the adapter.
 *
 * Where the docs are silent this fake picks one shape and says so (marked ASSUMED below); the adapter must not depend on
 * those shapes beyond "an error is an error".
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

/**
 * Gkash's online-API signature, written independently of the adapter (spec §4.1/§4.2): the `;`-joined parts, the
 * WHOLE string upper-cased (key included), SHA-512, lowercase hex.
 */
const sign = (parts: string[]) => createHash('sha512').update(parts.join(';').toUpperCase()).digest('hex')

/** "10.50" → "1050", "0.10" → "010": two decimals, dot removed, leading zero kept (spec §4.1). */
const amt = (ringgit: string) => Number(ringgit).toFixed(2).replace('.', '')

interface Payment {
  poid: string
  cartid: string
  /** As Gkash shows it: ringgit with two decimals. */
  amount: string
  currency: string
  status: string
  description: string
}

export interface FakeGkash extends FakeGateway {
  /** Every request received: JSON body as posted, and headers. */
  requests: {
    method: string
    path: string
    body: Record<string, unknown>
    contentType: string | undefined
    headers: Record<string, string | string[] | undefined>
  }[]
  /** Set the full status text Gkash would report (e.g. `66 - Failed`), for tests of other outcomes. */
  setStatus(id: string, status: string): void
}

/** The id the adapter hands out is `<cartid>:<amount in sen>`; the fake keeps payments by cart id. */
const cartOf = (id: string) => id.replace(/:\d+$/, '')

export async function startFakeGkash(opts: { cid: string; signatureKey: string }): Promise<FakeGkash> {
  let n = 0
  const payments = new Map<string, Payment>()
  const requests: FakeGkash['requests'] = []
  let origin = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const contentType = req.headers['content-type']
      let body: Record<string, unknown> = {}
      try {
        const j = raw ? JSON.parse(raw) : {}
        if (j && typeof j === 'object' && !Array.isArray(j)) body = j
      } catch {}
      const path = req.url ?? ''
      requests.push({ method: req.method ?? '', path, body, contentType, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      // ASSUMED: the docs publish no error body or HTTP status for refused requests.
      const error = (status: number, message: string) => send(status, { message })
      const s = (k: string) => (body[k] == null ? '' : String(body[k]))

      if (req.method === 'POST' && path === '/api/payment/form') {
        if (!contentType?.includes('application/json')) return error(415, 'Unsupported content type')
        // DOC says 1.5.5; the official plugin and every SDK send 1.5.0 (spec C1). Both are accepted here.
        if (!['1.5.0', '1.5.5'].includes(s('version'))) return error(400, 'Invalid version')
        if (s('CID') !== opts.cid) return error(400, 'Invalid merchant')
        const cartid = s('v_cartid')
        if (!/^[A-Za-z0-9._-]+$/.test(cartid)) return error(400, 'Invalid cart id')
        if (s('v_currency') !== 'MYR') return error(400, 'Only supports MYR')
        if (!/^\d+\.\d{2}$/.test(s('v_amount')) || Number(s('v_amount')) <= 0)
          return error(400, 'Invalid amount')
        const expected = sign([opts.signatureKey, opts.cid, cartid, amt(s('v_amount')), 'MYR'])
        if (s('signature') !== expected) return error(400, 'Invalid signature')
        // ASSUMED: what Gkash does with a reused cart id is undocumented; the fake refuses it (the plugin's comment
        // says "Gkash requires a unique cart id per request").
        if (payments.has(cartid)) return error(400, 'Duplicate cart id')
        n += 1
        const p: Payment = {
          poid: `M161-PO-${String(n).padStart(6, '0')}`,
          cartid,
          amount: s('v_amount'),
          currency: 'MYR',
          status: '11 - Pending',
          description: '',
        }
        payments.set(cartid, p)
        // DOC v2 checkout-session response; its signature uses the callback formula with `11 - PENDING` (C8).
        return send(200, {
          status: p.status,
          cid: opts.cid,
          poId: p.poid,
          cartId: p.cartid,
          amount: p.amount,
          currency: p.currency,
          signature: sign([
            opts.signatureKey,
            opts.cid,
            p.poid,
            p.cartid,
            amt(p.amount),
            p.currency,
            p.status,
          ]),
          redirect: { url: `${origin}/pay/${p.poid}` },
        })
      }

      if (req.method === 'POST' && path === '/api/payment/query') {
        if (s('version') !== '1.3.0') return error(400, 'Invalid version')
        if (s('CID') !== opts.cid) return error(400, 'Invalid merchant')
        const expected = sign([opts.signatureKey, opts.cid, s('cartid'), amt(s('amount')), s('currency')])
        if (s('signature') !== expected) return error(400, 'Invalid signature')
        const p = payments.get(s('cartid'))
        // ASSUMED: the answer for an unknown cart id is undocumented.
        if (!p) return error(404, 'Transaction not found')
        // DOC query-transaction-status: unsigned, no paid time; refund fields present (values ASSUMED empty).
        return send(200, {
          CID: opts.cid,
          POID: p.poid,
          status: p.status,
          cartid: p.cartid,
          currency: p.currency,
          amount: p.amount,
          description: p.description,
          PaymentType: '',
          refundstatus: '',
          refundamount: '',
          refunddate: '',
        })
      }
      error(404, 'Not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const payment = (id: string) => {
    const p = payments.get(cartOf(id))
    if (!p) throw new Error(`fake Gkash: no payment ${id}`)
    return p
  }

  return {
    url: origin,
    requests,
    markPaid(id) {
      const p = payment(id)
      p.status = '88 - Transferred'
      p.description = '00 - Approved'
    },
    setStatus(id, status) {
      payment(id).status = status
    },
    callbackFor(id, override = {}) {
      const p = payment(id)
      // Form fields exactly as Gkash posts them (spec §5). It claims success even before markPaid (a replayed or
      // forged-with-a-leaked-key callback); the fake's own record stays as it is.
      const fields: Record<string, string> = {
        CID: opts.cid,
        POID: p.poid,
        status: '88 - Transferred',
        cartid: p.cartid,
        currency: p.currency,
        amount: p.amount,
        description: '00 - Approved',
        ...override,
      }
      const { signature, ...rest } = fields
      const posted = {
        ...rest,
        signature:
          signature ??
          sign([
            opts.signatureKey,
            rest.CID ?? '',
            rest.POID ?? '',
            rest.cartid ?? '',
            amt(rest.amount ?? ''),
            rest.currency ?? '',
            rest.status ?? '',
          ]),
      }
      return {
        fields: posted,
        rawBody: new URLSearchParams(posted).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper: (cb) => {
      const fields = { ...cb.fields, signature: flip(cb.fields.signature ?? '') }
      // The body must say what the fields say: a real tampered POST carries the altered value in its bytes too.
      return { ...cb, fields, rawBody: cb.rawBody ? new URLSearchParams(fields).toString() : '' }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
