/**
 * A fake Billplz API (V3 Bills), built from the official documentation (support.billplz.com/api) and the official
 * WooCommerce plugin's signing code — see gateways/billplz/spec.md. NOT yet measured against the sandbox: when someone
 * does, change this file first so it answers like the real thing, then the adapter.
 *
 * Where the docs are silent this fake picks one shape and says so (marked ASSUMED below); the adapter must not depend on
 * those shapes beyond "an error is an error".
 */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

/**
 * X Signature, written independently of the adapter (spec §5.1): one `key+value` string per parameter except
 * `x_signature` (nested keys flattened, `billplz[id]` → `billplzid`), sort those STRINGS ascending case-insensitively,
 * join with `|`, HMAC-SHA256 with the X Signature key, lowercase hex.
 */
const sign = (key: string, fields: Record<string, string>) => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    const flat = k.replaceAll('[', '').replaceAll(']', '')
    if (flat === 'x_signature' || flat === 'billplzx_signature') continue
    parts.push(`${flat}${v}`)
  }
  parts.sort((a, b) => {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
  })
  return createHmac('sha256', key).update(parts.join('|')).digest('hex')
}

interface Bill {
  id: string
  collection_id: string
  paid: boolean
  state: 'due' | 'paid' | 'deleted'
  amount: number
  paid_amount: number
  due_at: string
  email: string | null
  mobile: string | null
  name: string
  url: string
  reference_1_label: string
  reference_1: string | null
  reference_2_label: string
  reference_2: string | null
  redirect_url: string | null
  callback_url: string
  description: string
  paid_at: string | null
}

export interface FakeBillplz extends FakeGateway {
  /** Every request received: body fields as posted (form or JSON), and headers. */
  requests: {
    method: string
    path: string
    body: Record<string, unknown>
    contentType: string | undefined
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The redirect query (`billplz[id]`, `billplz[paid]`, `billplz[paid_at]`, `billplz[x_signature]`) as decoded fields. */
  redirectFor(id: string, override?: Record<string, string>): CallbackInput
}

const MY_OFFSET_MS = 8 * 3600_000
const pad = (n: number) => String(n).padStart(2, '0')
const myNow = () => new Date(Date.now() + MY_OFFSET_MS)
/** Doc examples show due_at NOT zero-padded ("2018-9-27"). */
const dueToday = () => {
  const d = myNow()
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
}
/** Callback/redirect format: "2018-09-27 15:15:09 +0800". */
const paidNow = () => {
  const d = myNow()
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0800`
}

export async function startFakeBillplz(opts: {
  secretKey: string
  xSignatureKey: string
  collectionId: string
}): Promise<FakeBillplz> {
  let n = 0
  const bills = new Map<string, Bill>()
  const requests: FakeBillplz['requests'] = []
  const expectedAuth = `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`
  let origin = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const contentType = req.headers['content-type']
      let body: Record<string, unknown> = {}
      if (contentType?.includes('application/json')) {
        try {
          const j = raw ? JSON.parse(raw) : {}
          if (j && typeof j === 'object' && !Array.isArray(j)) body = j
        } catch {}
      } else {
        body = Object.fromEntries(new URLSearchParams(raw))
      }
      const path = req.url ?? ''
      requests.push({ method: req.method ?? '', path, body, contentType, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      // ASSUMED: the docs give the error body only for 429 (`{"error":{"type","message":[…]}}`); other codes reuse it.
      const error = (status: number, type: string, message: string) =>
        send(status, { error: { type, message: [message] } })

      // Docs: HTTP Basic, secret key as username, empty password; a wrong key (or the other environment's) → 401.
      if (req.headers.authorization !== expectedAuth)
        return error(401, 'Unauthorized', 'Invalid access token')

      if (req.method === 'POST' && path === '/api/v3/bills') {
        const s = (k: string) => (body[k] == null ? '' : String(body[k]).trim())
        const problems: string[] = []
        if (!s('collection_id')) problems.push('Collection is required')
        else if (s('collection_id') !== opts.collectionId) problems.push('Collection not found') // ASSUMED code 422
        if (!s('email') && !s('mobile')) problems.push('Email or mobile is required')
        if (s('mobile') && !/^\+?\d+$/.test(s('mobile'))) problems.push('Mobile is invalid')
        if (!s('name')) problems.push('Name is required')
        else if ([...s('name')].length > 255) problems.push('Name is too long (maximum is 255 characters)')
        const amount = body.amount
        const amountOk =
          (typeof amount === 'number' && Number.isInteger(amount) && amount > 0) ||
          (typeof amount === 'string' && /^[1-9]\d*$/.test(amount))
        if (!amountOk) problems.push('Amount must be a positive integer')
        if (!s('callback_url')) problems.push('Callback url is required')
        if (!s('description')) problems.push('Description is required')
        else if ([...s('description')].length > 200)
          problems.push('Description is too long (maximum is 200 characters)')
        for (const k of ['reference_1_label', 'reference_2_label'])
          if ([...s(k)].length > 20) problems.push(`${k} is too long (maximum is 20 characters)`)
        for (const k of ['reference_1', 'reference_2'])
          if ([...s(k)].length > 120) problems.push(`${k} is too long (maximum is 120 characters)`)
        if (problems.length) return send(422, { error: { type: 'Unprocessable', message: problems } })

        n += 1
        const id = `fk${String(n).padStart(6, '0')}`
        const bill: Bill = {
          id,
          collection_id: s('collection_id'),
          paid: false,
          state: 'due',
          amount: Number(amount),
          paid_amount: 0,
          due_at: s('due_at') || dueToday(),
          email: s('email') || null,
          mobile: s('mobile') || null,
          name: s('name'),
          url: `${origin}/bills/${id}`,
          reference_1_label: s('reference_1_label') || 'Reference 1',
          reference_1: s('reference_1') || null,
          reference_2_label: s('reference_2_label') || 'Reference 2',
          reference_2: s('reference_2') || null,
          redirect_url: s('redirect_url') || null,
          callback_url: s('callback_url'),
          description: s('description'),
          paid_at: null,
        }
        bills.set(id, bill)
        const { paid_at: _omit, ...created } = bill
        return send(200, created)
      }
      const one = /^\/api\/v3\/bills\/([A-Za-z0-9]+)$/.exec(path)
      if (one) {
        const bill = bills.get(one[1] ?? '')
        if (!bill) return error(404, 'RecordNotFound', 'The requested bill does not exist')
        if (req.method === 'GET') {
          // Doc examples: the name comes back upper-cased; `paid_at` is absent from Get-a-Bill examples (UNCONFIRMED).
          const { paid_at: _omit, ...shown } = bill
          return send(200, { ...shown, name: bill.name.toUpperCase() })
        }
        if (req.method === 'DELETE') {
          // Docs: only due bills can be deleted; a paid bill → 422. ASSUMED: deleting a deleted bill is also 422.
          if (bill.state !== 'due') return error(422, 'Unprocessable', `Bill is ${bill.state}`)
          bill.state = 'deleted'
          return send(200, {})
        }
      }
      error(404, 'RecordNotFound', 'Not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const bill = (id: string) => {
    const b = bills.get(id)
    if (!b) throw new Error(`fake Billplz: no bill ${id}`)
    return b
  }

  return {
    url: `${origin}/api`,
    requests,
    markPaid(id) {
      // Docs: a deleted bill comes back when a payment already in flight completes.
      const b = bill(id)
      b.paid = true
      b.state = 'paid'
      b.paid_amount = b.amount
      b.paid_at = paidNow()
    },
    callbackFor(id, override = {}) {
      const b = bill(id)
      // Flat fields exactly as Billplz posts them (spec §5.2), form-encoded; null becomes "". It claims a successful
      // payment even before markPaid (a replayed or forged-with-a-leaked-key callback).
      const fields: Record<string, string> = {
        id: b.id,
        collection_id: b.collection_id,
        paid: 'true',
        state: 'paid',
        amount: String(b.amount),
        paid_amount: String(b.amount),
        due_at: b.due_at,
        email: b.email ?? '',
        mobile: b.mobile ?? '',
        name: b.name.toUpperCase(),
        url: b.url,
        paid_at: b.paid_at ?? paidNow(),
        ...override,
      }
      const { x_signature, ...signed } = fields
      const posted = { ...signed, x_signature: x_signature ?? sign(opts.xSignatureKey, signed) }
      return {
        fields: posted,
        rawBody: new URLSearchParams(posted).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    redirectFor(id, override = {}) {
      const b = bill(id)
      const fields: Record<string, string> = {
        'billplz[id]': b.id,
        'billplz[paid]': 'true',
        'billplz[paid_at]': b.paid_at ?? paidNow(),
        ...override,
      }
      const { 'billplz[x_signature]': given, ...signed } = fields
      return {
        fields: { ...signed, 'billplz[x_signature]': given ?? sign(opts.xSignatureKey, signed) },
        rawBody: '',
        headers: {},
      }
    },
    tamper: (cb) => {
      const k = 'billplz[x_signature]' in cb.fields ? 'billplz[x_signature]' : 'x_signature'
      const fields = { ...cb.fields, [k]: flip(cb.fields[k] ?? '') }
      // The body must say what the fields say: a real tampered POST carries the altered value in its bytes too.
      return { ...cb, fields, rawBody: cb.rawBody ? new URLSearchParams(fields).toString() : '' }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
