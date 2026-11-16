/**
 * A fake Sampan Pay: USD invoices paid in Bitcoin Cash, converted by Sampan to PUSD at the merchant's own address.
 *
 * Written from the Sampan Pay invoice API design (16 November 2026, not yet public), NOT measured: the API was not live yet.
 * What the plan fixes, and this fake keeps: `POST /api/pay/invoice` takes `{usd, merchantAddress, webhookUrl?,
 * webhookSecret?, orderId?, returnUrl?}` and answers `{id, address, bip21, qrSvgUrl, statusUrl, requiredSats, expiresAt,
 * webhookSecret?}` (the secret only when Sampan generated it); `GET /api/pay/invoice/:id` answers the status with
 * `payments[{txid, sats}]`, `convert[{txid, pusd}]` and `webhook{state, attempts}`; statuses `open | paid | underpaid |
 * overpaid | expired | paid_late`; webhooks follow Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, the same `webhook-id` on every retry), event
 * types `invoice.<status>`; webhook URLs must be HTTPS and not private; ids are 128-bit random; errors are
 * `{error, message}`; every /api/pay route answers 404 while Sampan's pay flag is off.
 *
 * Assumed until measured (change the fake first, test red, then the adapter): `usd` is a string with at most two
 * decimals and the GET answer echoes `usd`, `orderId` and `merchantAddress`; `expiresAt` is ISO 8601; webhook secrets
 * are Standard Webhooks `whsec_<base64>`; the event body is `{type, timestamp, data}` with `data` = the GET answer;
 * the error codes other than `flow_closed`; `webhook.state` values; a payment counts once Sampan has converted it.
 * Addresses are shaped like cashaddr but carry no valid checksum.
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
  orderId?: string
  merchantAddress: string
  address: string
  requiredSats: number
  expiresAt: string
  returnUrl?: string
  payments: { txid: string; sats: number }[]
  convert: { txid: string; pusd: string }[]
  webhook: { state: string; attempts: number } | null
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
const USD = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/
const SECRET = /^whsec_[A-Za-z0-9+/]{24,}={0,2}$/
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
  const min = cents(opts.minUsd ?? '0.10')
  const max = cents(opts.maxUsd ?? '1000.00')
  const under = opts.underToleranceBps ?? 0
  const over = opts.overToleranceBps ?? 0
  const invoices = new Map<string, Invoice>()
  const requests: FakeSampan['requests'] = []
  const created: number[] = []
  let url = ''

  const statusOf = (inv: Invoice): SampanStatus => {
    const done = inv.payments.filter((p) => p.convertTxid)
    const total = done.reduce((s, p) => s + p.sats, 0)
    if (total === 0) return Date.now() > inv.expiresAt ? 'expired' : 'open'
    if (total < inv.requiredSats - Math.floor((inv.requiredSats * under) / 10_000)) return 'underpaid'
    const late = done.some((p) => p.at > inv.expiresAt)
    if (total > inv.requiredSats + Math.floor((inv.requiredSats * over) / 10_000))
      return late ? 'paid_late' : 'overpaid'
    return late ? 'paid_late' : 'paid'
  }
  const view = (inv: Invoice): SampanInvoice => {
    const status = statusOf(inv)
    return {
      id: inv.id,
      status,
      usd: dollars(inv.cents),
      ...(inv.body.orderId === undefined ? {} : { orderId: inv.body.orderId }),
      merchantAddress: inv.body.merchantAddress ?? '',
      address: inv.address,
      requiredSats: inv.requiredSats,
      expiresAt: new Date(inv.expiresAt).toISOString(),
      ...(inv.body.returnUrl === undefined ? {} : { returnUrl: inv.body.returnUrl }),
      payments: inv.payments.map((p) => ({ txid: p.txid, sats: p.sats })),
      convert: inv.payments.flatMap((p) =>
        p.convertTxid
          ? [{ txid: p.convertTxid, pusd: dollars(Math.floor((inv.cents * p.sats) / inv.requiredSats)) }]
          : [],
      ),
      webhook: inv.body.webhookUrl ? { state: status === 'open' ? 'idle' : 'queued', attempts: 0 } : null,
    }
  }

  const createInvoice = (raw: string): [number, unknown] => {
    const bad = (error: string, message: string): [number, unknown] => [400, { error, message }]
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return bad('bad_request', 'body must be JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return bad('bad_request', 'body must be an object')
    for (const k of Object.keys(body)) if (!KEYS.has(k)) return bad('bad_request', `body/${k} is not allowed`)
    for (const [k, v] of Object.entries(body))
      if (typeof v !== 'string') return bad('bad_request', `body/${k} must be string`)
    const b = body as Record<string, string>
    if (b.usd === undefined || b.merchantAddress === undefined)
      return bad('bad_request', "body must have required properties 'usd', 'merchantAddress'")
    if (!USD.test(b.usd)) return bad('bad_request', 'body/usd must be dollars with at most two decimals')
    const c = cents(b.usd)
    if (c < min || c > max)
      return bad('amount_out_of_range', `usd must be between ${dollars(min)} and ${dollars(max)}`)
    if (!TOKEN_ADDRESS.test(b.merchantAddress))
      return bad('bad_address', 'merchantAddress must be a token-aware Bitcoin Cash address')
    if (b.webhookSecret !== undefined && !SECRET.test(b.webhookSecret))
      return bad('bad_request', 'body/webhookSecret must be whsec_ followed by base64')
    if (b.webhookUrl !== undefined) {
      let u: URL
      try {
        u = new URL(b.webhookUrl)
      } catch {
        return bad('bad_webhook_url', 'webhookUrl must be an https URL')
      }
      if (u.protocol !== 'https:') return bad('bad_webhook_url', 'webhookUrl must be an https URL')
      if (privateHost(u.hostname))
        return bad('bad_webhook_url', 'webhookUrl must not point at a private address')
    }
    const hourAgo = Date.now() - 3_600_000
    while (created.length && (created[0] ?? 0) < hourAgo) created.shift()
    if (created.length >= (opts.invoicesPerHour ?? Number.POSITIVE_INFINITY))
      return [429, { error: 'rate_limited', message: 'too many invoices from this address, try again later' }]
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
      expiresAt: Date.now() + (opts.validMinutes ?? 30) * 60_000,
      payments: [],
    }
    invoices.set(id, inv)
    return [
      201,
      {
        id,
        address,
        bip21: `${address}?amount=${bch(requiredSats)}`,
        qrSvgUrl: `${url}/api/pay/invoice/${id}/qr.svg`,
        statusUrl: `${url}/pay/i/${id}`,
        requiredSats,
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
        return send(404, { error: 'flow_closed', message: 'Sampan Pay is not open yet' })
      if (req.method === 'POST' && path === '/api/pay/invoice') return send(...createInvoice(body))
      const get = /^\/api\/pay\/invoice\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && get) {
        const inv = invoices.get(get[1] ?? '')
        return inv ? send(200, view(inv)) : send(404, { error: 'not_found', message: 'no such invoice' })
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
      const event = {
        type: `invoice.${type}`,
        timestamp: new Date().toISOString(),
        data: { ...view(inv), status: type, ...fields },
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
