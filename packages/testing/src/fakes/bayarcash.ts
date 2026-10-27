/**
 * A fake Bayarcash API v3. Shapes MEASURED on the sandbox 27 Oct 2026 (api.console.bayarcash-sandbox.com, FPX mock bank,
 * one paid and one failed payment): creating an intent answers 201 with `amount` as a number and one `payment_channel`;
 * `GET /payment-intents/{id}` answers 201 (a read, still 201) with `status` "unpaid"/"paid" and its `attempts`;
 * `/transactions/{intent id}` is 404 (an intent is not a transaction); a transaction names its portal by NAME (`portal`),
 * not by key. Callback field lists still come from the official PHP SDK: the sandbox sent no server callback.
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
  /** Shown as `portal` on every transaction and in GET /portals. */
  portalName?: string
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
      if (req.method === 'GET' && path === '/portals') {
        return send(200, {
          data: [
            {
              portal_key: opts.portalKey,
              portal_name: portalName,
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
