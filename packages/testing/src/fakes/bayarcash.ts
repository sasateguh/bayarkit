/**
 * A fake Bayarcash API v3, built from the official documentation and PHP SDK (not yet measured against the sandbox).
 * When someone measures the sandbox, change this file first so it answers like the real thing, then the adapter.
 */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
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

export interface FakeBayarcash extends FakeGateway {
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
}): Promise<FakeBayarcash> {
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
        const channels = Array.isArray(body.payment_channel)
          ? body.payment_channel.join(',')
          : String(body.payment_channel)
        const expected = sign(opts.secretKey, {
          payment_channel: channels,
          order_number: String(body.order_number ?? ''),
          amount: String(body.amount ?? ''),
          payer_name: String(body.payer_name ?? ''),
          payer_email: String(body.payer_email ?? ''),
        })
        if (body.checksum !== expected) return send(422, { message: 'Invalid checksum.' })
        if (body.portal_key !== opts.portalKey) return send(422, { message: 'Invalid portal key.' })
        const id = `pi_fake${++n}`
        intents.set(id, { id, body })
        return send(200, { id, url: `https://fake.bayarcash.test/pay/${id}` })
      }
      const tx = /^\/transactions\/([A-Za-z0-9_-]+)$/.exec(path)
      if (req.method === 'GET' && tx) {
        const t = transactions.get(tx[1] ?? '')
        if (!t) return send(404, { message: 'Not found.' })
        return send(200, { ...t, id: t.transaction_id, amount: Number(t.amount) })
      }
      if (req.method === 'GET' && path === '/portals') {
        return send(200, {
          data: [
            {
              portal_key: opts.portalKey,
              portal_name: 'Fake portal',
              payment_channels: [{ id: 1, name: 'FPX' }],
            },
          ],
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
      status_description: status === '3' ? 'Approved' : 'Pending',
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
    tamper: (cb) => ({ ...cb, fields: { ...cb.fields, checksum: flip(cb.fields.checksum ?? '') } }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
