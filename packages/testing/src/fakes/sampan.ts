/**
 * A fake Sampan Pay: USD invoices paid in Bitcoin Cash, converted by Sampan to PUSD at the merchant's own address.
 *
 * Matched against the live API on 16 November 2026 (one unpaid USD 0.20 invoice, its GET answer and the error answers;
 * no payment and no webhook measured yet). What the live API does, and this fake keeps:
 * - `POST /api/pay/invoice` takes `{usd, merchantAddress, webhookUrl?, webhookSecret?, orderId?, returnUrl?}`; `usd` is a
 *   JSON number (a numeric string is coerced), at most two decimals, USD 0.20 to 250 on the live site. It answers 200
 *   `{id, address, bip21, qrSvgUrl, statusUrl, usd, requiredSats, expiresAt, webhookSecret?}`: `id` is 32 hex digits,
 *   `usd` a two-decimal string, `requiredSats` a decimal string, the secret only when Sampan generated it.
 * - `GET /api/pay/invoice/:id` answers `{id, status, usd, address, bip21, requiredSats, paidSats, expiresAt, createdAt,
 *   orderId|null, returnUrl|null, payments[{txid, sats}], convert[{txid, pusd}], webhook{state, attempts}}` (sats as
 *   strings, no merchant address). `webhook.state` is `none` without a webhook URL, `pending` before delivery.
 * - Errors: Sampan's own checks answer `{error, message}` (`below_min`, `above_max`, `bad_request`, `not_found`,
 *   `rate_limited`); a body or id the schema refuses answers the web framework's `{statusCode: 400, code:
 *   'FST_ERR_VALIDATION', error: 'Bad Request', message}`. Every /api/pay route answers 404 `not_found` while pay is off.
 *
 * From Sampan's code and config, not measured: status counts every payment SEEN at the address (summed), before any
 * conversion; under/over tolerances 50/100 bps; `paid_late` when the first payment is seen after `expiresAt`, whatever
 * its size; webhooks follow Standard Webhooks (`webhook-id` `msg_<hex>`, the same on every retry, `webhook-timestamp`,
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`), body `{type, timestamp, data}` with `data` =
 * the GET answer without `webhook`; events `invoice.paid|underpaid|overpaid|paid_late`. Webhook URLs must be HTTPS and
 * not private. Addresses are shaped like cashaddr but carry no valid checksum.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

export type SampanStatus = 'open' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'paid_late'

/** `GET /api/pay/invoice/:id`, and `data` of every webhook event. */
export interface SampanInvoice {
  id: string
  status: SampanStatus
  usd: string
  address: string
  bip21: string
  requiredSats: string
  paidSats: string
  expiresAt: string
  createdAt: string
  orderId: string | null
  returnUrl: string | null
  payments: { txid: string; sats: string }[]
  convert: { txid: string; pusd: string }[]
  webhook: { state: string; attempts: number }
}

export interface FakeSampan extends FakeGateway {
  /** Every request received, for assertions. */
  requests: {
    method: string
    path: string
    body: string
    headers: Record<string, string | string[] | undefined>
  }[]
  /** A BCH payment of `sats` to the invoice address; `converted: false` = Sampan has not turned it into PUSD yet. */
  pay(id: string, sats: number, opts?: { converted?: boolean }): void
  /** Move the invoice's `expiresAt` into the past. */
  expire(id: string): void
}

const CASHADDR = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const TOKEN_ADDRESS = /^(bitcoincash:)?[zr][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41,60}$/
const NUMERIC = /^-?[0-9]+(\.[0-9]+)?$/
const SECRET = /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/
const ORDER_ID = /^[A-Za-z0-9._:-]{1,64}$/
const KEYS = new Set(['usd', 'merchantAddress', 'webhookUrl', 'webhookSecret', 'orderId', 'returnUrl'])

/** `v1,<base64>` exactly as Standard Webhooks builds it: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`. */
export function sampanSignature(secret: string, msgId: string, timestamp: number, rawBody: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${msgId}.${timestamp}.${rawBody}`, 'utf8').digest('base64')}`
}

const cents = (usd: string): number => {
  const [whole = '0', frac = ''] = usd.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}
const dollars = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`
const bch = (sats: number): string => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '')
const txid = (): string => randomBytes(32).toString('hex')
const hash2 = (id: string): string => `${id}.address`

function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h)
  if (!v4) return /^f[cd]|^fe80/.test(h)
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

interface Invoice {
  id: string
  cents: number
  body: Record<string, string>
  secret: string | undefined
  address: string
  requiredSats: number
  createdAt: number
  expiresAt: number
  payments: { txid: string; sats: number; at: number; convertTxid: string | undefined }[]
}

export async function startFakeSampan(
  opts: {
    /** Sampan's pay flag; false = every /api/pay route is 404 `flow_closed`. */
    pay?: boolean
    satsPerUsd?: number
    minUsd?: string
    maxUsd?: string
    underToleranceBps?: number
    overToleranceBps?: number
    validMinutes?: number
    invoicesPerHour?: number
    /** The secret Sampan answers when an invoice has a webhook URL but no secret (random when unset). */
    webhookSecret?: string
  } = {},
): Promise<FakeSampan> {
  const satsPerUsd = opts.satsPerUsd ?? 200_000
  const min = cents(opts.minUsd ?? '0.20')
  const max = cents(opts.maxUsd ?? '250.00')
  const under = opts.underToleranceBps ?? 50
  const over = opts.overToleranceBps ?? 100
  const invoices = new Map<string, Invoice>()
  const requests: FakeSampan['requests'] = []
  const created: number[] = []
  let url = ''

  const statusOf = (inv: Invoice): SampanStatus => {
    if (inv.payments.length === 0) return Date.now() >= inv.expiresAt ? 'expired' : 'open'
    if (Math.min(...inv.payments.map((p) => p.at)) >= inv.expiresAt) return 'paid_late'
    const total = inv.payments.reduce((s, p) => s + p.sats, 0)
    if (total < Math.floor((inv.requiredSats * (10_000 - under)) / 10_000)) return 'underpaid'
    if (total > Math.floor((inv.requiredSats * (10_000 + over)) / 10_000)) return 'overpaid'
    return 'paid'
  }
  const view = (inv: Invoice): SampanInvoice => ({
    id: inv.id,
    status: statusOf(inv),
    usd: dollars(inv.cents),
    address: inv.address,
    bip21: `${inv.address}?amount=${bch(inv.requiredSats)}`,
    requiredSats: String(inv.requiredSats),
    paidSats: String(inv.payments.reduce((s, p) => s + p.sats, 0)),
    expiresAt: new Date(inv.expiresAt).toISOString(),
    createdAt: new Date(inv.createdAt).toISOString(),
    orderId: inv.body.orderId ?? null,
    returnUrl: inv.body.returnUrl ?? null,
    payments: inv.payments.map((p) => ({ txid: p.txid, sats: String(p.sats) })),
    convert: inv.payments.flatMap((p) =>
      p.convertTxid
        ? [{ txid: p.convertTxid, pusd: dollars(Math.floor((inv.cents * p.sats) / inv.requiredSats)) }]
        : [],
    ),
    webhook: { state: inv.body.webhookUrl ? 'pending' : 'none', attempts: 0 },
  })

  const createInvoice = (raw: string): [number, unknown] => {
    const bad = (error: string, message: string): [number, unknown] => [400, { error, message }]
    // What the web framework answers when the request schema refuses the body (measured).
    const schema = (message: string): [number, unknown] => [
      400,
      { statusCode: 400, code: 'FST_ERR_VALIDATION', error: 'Bad Request', message },
    ]
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return schema('body is not valid JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return schema('body must be object')
    for (const k of ['usd', 'merchantAddress'])
      if (body[k] === undefined) return schema(`body must have required property '${k}'`)
    for (const k of Object.keys(body))
      if (!KEYS.has(k)) return schema('body must NOT have additional properties')
    // The schema types `usd` as a number and coerces a numeric string.
    const usd = typeof body.usd === 'string' && NUMERIC.test(body.usd) ? Number(body.usd) : body.usd
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return schema('body/usd must be number')
    for (const [k, v] of Object.entries(body))
      if (k !== 'usd' && typeof v !== 'string') return schema(`body/${k} must be string`)
    const b = body as Record<string, string>
    if (b.orderId !== undefined && !ORDER_ID.test(b.orderId))
      return schema(`body/orderId must match pattern "${ORDER_ID.source}"`)
    if (usd < min / 100) return bad('below_min', `an invoice is at least ${min / 100} USD`)
    if (usd > max / 100) return bad('above_max', `an invoice is at most ${max / 100} USD`)
    const c = Math.round(usd * 100)
    if (Math.abs(c - usd * 100) > 1e-6) return bad('bad_request', 'usd must have at most 2 decimals')
    if (!TOKEN_ADDRESS.test(b.merchantAddress ?? ''))
      return bad(
        'bad_request',
        'merchantAddress must be a token-aware address (z... or r...) that can receive PUSD',
      )
    if (b.webhookSecret !== undefined && b.webhookUrl === undefined)
      return bad('bad_request', 'webhookSecret needs a webhookUrl')
    if (b.webhookSecret !== undefined && !SECRET.test(b.webhookSecret))
      return bad('bad_request', 'webhookSecret must be whsec_ followed by base64 of at least 24 bytes')
    if (b.returnUrl !== undefined && !/^https:\/\//.test(b.returnUrl))
      return bad('bad_request', 'returnUrl must be an https URL')
    if (b.webhookUrl !== undefined) {
      let u: URL
      try {
        u = new URL(b.webhookUrl)
      } catch {
        return bad('bad_request', 'webhookUrl must be an https URL')
      }
      if (u.protocol !== 'https:') return bad('bad_request', 'webhookUrl must be an https URL')
      if (privateHost(u.hostname))
        return bad('bad_request', `webhookUrl host ${u.hostname} is a private, loopback or reserved address`)
    }
    const hourAgo = Date.now() - 3_600_000
    while (created.length && (created[0] ?? 0) < hourAgo) created.shift()
    if (created.length >= (opts.invoicesPerHour ?? Number.POSITIVE_INFINITY))
      return [429, { error: 'rate_limited', message: 'too many requests; try again shortly' }]
    created.push(Date.now())

    const id = randomBytes(16).toString('hex')
    // A landing address is P2SH; 41 cashaddr characters from the id (two hashes: one is only 32 bytes).
    const hash = Buffer.concat([
      createHash('sha256').update(id).digest(),
      createHash('sha256').update(hash2(id)).digest(),
    ])
    const address = `bitcoincash:p${Array.from(hash.subarray(0, 41), (x) => CASHADDR[x % 32]).join('')}`
    const generated = b.webhookUrl !== undefined && b.webhookSecret === undefined
    const secret =
      b.webhookSecret ??
      (generated ? (opts.webhookSecret ?? `whsec_${randomBytes(24).toString('base64')}`) : undefined)
    const requiredSats = Math.round((c * satsPerUsd) / 100)
    const inv: Invoice = {
      id,
      cents: c,
      body: b,
      secret,
      address,
      requiredSats,
      createdAt: Date.now(),
      expiresAt: Date.now() + (opts.validMinutes ?? 30) * 60_000,
      payments: [],
    }
    invoices.set(id, inv)
    return [
      200,
      {
        id,
        address,
        bip21: `${address}?amount=${bch(requiredSats)}`,
        qrSvgUrl: `${url}/api/pay/invoice/${id}/qr.svg`,
        statusUrl: `${url}/pay/i/${id}`,
        usd: dollars(c),
        requiredSats: String(requiredSats),
        expiresAt: new Date(inv.expiresAt).toISOString(),
        ...(generated ? { webhookSecret: secret } : {}),
      },
    ]
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(o))
      }
      if (path.startsWith('/api/pay/') && opts.pay === false)
        return send(404, { error: 'not_found', message: 'not found' })
      if (req.method === 'POST' && path === '/api/pay/invoice') return send(...createInvoice(body))
      const get = /^\/api\/pay\/invoice\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && get) {
        if (!/^[0-9a-f]{32}$/.test(get[1] ?? ''))
          return send(400, {
            statusCode: 400,
            code: 'FST_ERR_VALIDATION',
            error: 'Bad Request',
            message: 'params/id must match pattern "^[0-9a-f]{32}$"',
          })
        const inv = invoices.get(get[1] ?? '')
        return inv ? send(200, view(inv)) : send(404, { error: 'not_found', message: 'unknown invoice' })
      }
      send(404, { error: 'not_found', message: 'no such route' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const known = (id: string) => {
    const inv = invoices.get(id)
    if (!inv) throw new Error(`fake Sampan: no invoice ${id}`)
    return inv
  }
  const pay = (id: string, sats: number, o: { converted?: boolean } = {}) => {
    known(id).payments.push({
      txid: txid(),
      sats: Math.round(sats),
      at: Date.now(),
      convertTxid: o.converted === false ? undefined : txid(),
    })
  }

  return {
    url,
    requests,
    pay,
    markPaid(id) {
      const inv = known(id)
      const paid = inv.payments.reduce((s, p) => s + p.sats, 0)
      pay(id, Math.max(inv.requiredSats - paid, 1))
    },
    expire(id) {
      known(id).expiresAt = Date.now() - 1000
    },
    /**
     * An `invoice.paid` event as Sampan would post it (even before `markPaid`; the fake's record is untouched).
     * `override.type` changes the event (and `data.status`); other keys change `data` before signing.
     */
    callbackFor(id, override = {}) {
      const inv = known(id)
      const { type = 'paid', ...fields } = override
      // The delivery state is not part of the event (Sampan drops `webhook` from `data`).
      const { webhook: _state, ...data } = view(inv)
      const event = {
        type: `invoice.${type}`,
        timestamp: new Date().toISOString(),
        data: { ...data, status: type, ...fields },
      }
      // Indented, so a handler that re-serialises the parsed JSON gets different bytes and the signature fails.
      const rawBody = JSON.stringify(event, null, 2)
      // One message id per invoice event, so every retry carries the same id (Standard Webhooks idempotency).
      const msgId = `msg_${createHash('sha256').update(`${id}.${event.type}`).digest('hex').slice(0, 32)}`
      const ts = Math.floor(Date.now() / 1000)
      return {
        fields: {},
        rawBody,
        headers: {
          'content-type': 'application/json',
          'webhook-id': msgId,
          'webhook-timestamp': String(ts),
          'webhook-signature': sampanSignature(inv.secret ?? opts.webhookSecret ?? '', msgId, ts, rawBody),
        },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: {
        ...cb.headers,
        'webhook-signature': (cb.headers['webhook-signature'] ?? '').replace(
          /^v1,(.+)$/,
          (_m, s: string) => `v1,${flip(s)}`,
        ),
      },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
