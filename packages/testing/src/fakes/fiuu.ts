/**
 * A fake Fiuu (formerly Razer Merchant Services / MOLPay), built from the official API spec PDF v13.97 and the
 * official plugins/SDKs — see gateways/fiuu/spec.md. NOT yet measured against the sandbox: when someone does, change
 * this file first so it answers like the real thing, then the adapter.
 *
 * What it serves (paths as in the spec, `/RMS/…`, not the plugins' `/MOLPay/…` alias, C9):
 * - `GET|POST /RMS/pay/{merchantID}/` — the hosted payment page. Checks `vcode` (standard, or extended with the
 *   currency when started with `extendedVcode`), the mandatory fields and the amount format, then registers the order;
 * - `GET|POST /RMS/q_by_tid.php` and `/RMS/query/q_by_oid.php` — status requery, `skey = md5(id.domain.verify_key.amount)`,
 *   answering `Key: value` lines (type 0, default) or JSON (type 2), signed with `VrfKey`.
 *
 * Fiuu has no server-side "create": the adapter only builds the payment URL. So this fake also knows an order from the
 * adapter's payment id (`<orderid>:<amount>`), and `callbackFor`/`markPaid` create the transaction (with its `tranID`)
 * when the page was never visited.
 *
 * Where the docs are silent this fake picks one shape and says so (ASSUMED); the adapter must not depend on those
 * shapes beyond "an error is an error".
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

/** Lowercase hex MD5 of a UTF-8 string — Fiuu's only hash. Written independently of the adapter. */
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

interface Txn {
  tranID: string
  orderid: string
  /** Ringgit exactly as the merchant sent it (spec: "2 decimal points"). */
  amount: string
  currency: string
  statCode: '00' | '11' | '22'
  statName: string
  appcode: string
  paydate: string
  channel: string
}

export interface FakeFiuu extends FakeGateway {
  /** Every request received (payment page and requery), with the fields as posted or in the query string. */
  requests: { method: string; path: string; fields: Record<string, string> }[]
  /** Set the transaction's requery status directly (e.g. `'11', 'failed'` or `'00', 'authorized'`). */
  setStatus(id: string, statCode: '00' | '11' | '22', statName: string): void
  /** From now on every requery answers this PSQ error code (e.g. `Q99`); `null` restores normal answers. */
  failQueriesWith(code: string | null): void
}

export interface FakeFiuuOptions {
  merchantId: string
  verifyKey: string
  secretKey: string
  /** Portal option "Use extended format for Verify Payment": vcode then includes the currency. Default false. */
  extendedVcode?: boolean
  /**
   * `type` is "obsoleted in new API sets" for q_by_tid (spec p73): with `'text'` every requery answers plain
   * `Key: value` lines whatever `type` asks for. Default `'type'` (JSON when `type=2`).
   */
  queryOutput?: 'type' | 'text'
}

const MY_OFFSET_MS = 8 * 3600_000
const pad = (n: number) => String(n).padStart(2, '0')
/** `YYYY-MM-DD HH:mm:ss`. ASSUMED Malaysia time: the spec states no timezone (UNCONFIRMED). */
const paydateNow = () => {
  const d = new Date(Date.now() + MY_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** PSQ error texts, SPEC p147. */
const PSQ_ERRORS: Record<string, string> = {
  Q01: 'Missing Required Parameter',
  Q02: 'Invalid Parameter Value',
  Q04: 'Merchant info not found.',
  Q99: 'Service blocked due to massive connection. Please send only 1 request every 5 minutes.',
  Q202: 'Incorrect skey',
  Q203: 'Transaction record not found',
  Q204: 'Incorrect amount',
}

export async function startFakeFiuu(opts: FakeFiuuOptions): Promise<FakeFiuu> {
  const byOrder = new Map<string, Txn>()
  const requests: FakeFiuu['requests'] = []
  let nextTranID = 3036581200
  let queryError: string | null = null
  let origin = ''

  const txnFor = (orderid: string, amount: string, currency = 'MYR'): Txn => {
    let t = byOrder.get(orderid)
    if (!t) {
      nextTranID += 1
      t = {
        tranID: String(nextTranID),
        orderid,
        amount,
        currency,
        statCode: '22',
        statName: 'pending',
        appcode: '',
        paydate: paydateNow(),
        channel: 'Credit',
      }
      byOrder.set(orderid, t)
    }
    return t
  }
  /** The adapter's payment id: `<orderid>:<amount>`, optionally `:<tranID>` (from a callback). */
  const fromId = (id: string): Txn => {
    const m = /^([^:]+):(\d+\.\d{2})(?::\d+)?$/.exec(id)
    if (!m?.[1] || !m[2]) throw new Error(`fake Fiuu: not a payment id: ${id}`)
    return txnFor(m[1], m[2])
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      // Spec: POST, GET or a mix; when both carry a parameter, POST wins (CHEAT L72).
      const fields: Record<string, string> = {
        ...Object.fromEntries(url.searchParams),
        ...Object.fromEntries(new URLSearchParams(raw)),
      }
      const path = url.pathname
      requests.push({ method: req.method ?? '', path, fields })
      const f = (k: string) => fields[k] ?? ''

      const pay = /^\/RMS\/pay\/([^/]+)\/?$/.exec(path)
      if (pay) {
        // ASSUMED shape: the payment page shows the error code in HTML with status 200 (SPEC p142 lists codes only).
        const page = (body: string) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(`<!doctype html><title>Fake Fiuu</title><p>${body}</p>`)
        }
        if (pay[1] !== opts.merchantId) return page('Error P01: Invalid merchant')
        const amount = f('amount')
        // SPEC p40: "integer or up to 2 decimal points", comma not allowed.
        if (!/^\d+(\.\d{1,2})?$/.test(amount)) return page('Error P02: Invalid amount')
        if (!/^[A-Za-z0-9-]{1,40}$/.test(f('orderid'))) return page('Error P02: Invalid orderid')
        if (!/^[A-Z]{3}$/.test(f('currency'))) return page('Error P02: Invalid currency')
        const vcodeSource = `${amount}${opts.merchantId}${f('orderid')}${opts.verifyKey}${opts.extendedVcode ? f('currency') : ''}`
        // ASSUMED: "Enable Verify Payment" is on, so vcode is mandatory (SPEC p19).
        if (f('vcode').toLowerCase() !== md5(vcodeSource)) return page('Error P03: Invalid vcode')
        // ASSUMED: the bill_* fields may be absent only with guest_checkout=1 (SPEC p40 says both "mandatory" and
        // "1 if the merchant does not hold the customer's bill_name, bill_email or bill_mobile").
        if (f('guest_checkout') !== '1' && (!f('bill_name') || !f('bill_email') || !f('bill_mobile')))
          return page('Error P02: Missing buyer details')
        if (!f('bill_desc')) return page('Error P02: Missing bill_desc')
        txnFor(f('orderid'), amount, f('currency'))
        return page(`Fake Fiuu payment page for ${f('orderid').replace(/[^A-Za-z0-9-]/g, '')}`)
      }

      const byTid = path === '/RMS/q_by_tid.php'
      const byOid = path === '/RMS/query/q_by_oid.php'
      if (byTid || byOid) {
        const json = f('type') === '2' && opts.queryOutput !== 'text'
        const answer = (o: Record<string, string | null>) => {
          res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/plain' })
          res.end(
            json
              ? JSON.stringify(o)
              : Object.entries(o)
                  .map(([k, v]) => `${k}: ${v ?? ''}`)
                  .join('\n'),
          )
        }
        // ASSUMED error shape: the spec gives codes and texts only (SPEC p147).
        const error = (code: string) =>
          answer({ StatCode: null, ErrorCode: code, ErrorDesc: PSQ_ERRORS[code] ?? 'Error' })
        if (queryError) return error(queryError)
        const id = byTid ? f('txID') : f('oID')
        if (!id || !f('domain') || !f('amount') || !f('skey')) return error('Q01')
        if (f('domain') !== opts.merchantId) return error('Q04')
        if (f('skey').toLowerCase() !== md5(`${id}${f('domain')}${opts.verifyKey}${f('amount')}`))
          return error('Q202')
        const t = byTid ? [...byOrder.values()].find((x) => x.tranID === id) : byOrder.get(id)
        if (!t) return error('Q203')
        if (Number(f('amount')) !== Number(t.amount)) return error('Q204')
        const Amount = Number(t.amount).toFixed(2)
        const VrfKey = md5(
          `${Amount}${opts.secretKey}${opts.merchantId}${byTid ? t.tranID : t.orderid}${t.statCode}`,
        )
        return answer({
          StatCode: t.statCode,
          StatName: t.statName,
          TranID: t.tranID,
          Amount,
          Domain: opts.merchantId,
          VrfKey,
          Channel: t.channel,
          OrderID: t.orderid,
          Currency: t.currency,
          ...(byOid ? { BillingDate: t.paydate } : {}),
          ErrorCode: json ? null : '',
          ErrorDesc: json ? null : '',
        })
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: origin,
    requests,
    markPaid(id) {
      const t = fromId(id)
      t.statCode = '00'
      t.statName = 'captured'
      t.appcode = '123456'
      t.paydate = paydateNow()
    },
    setStatus(id, statCode, statName) {
      const t = fromId(id)
      t.statCode = statCode
      t.statName = statName
    },
    failQueriesWith(code) {
      queryError = code
    },
    callbackFor(id, override = {}) {
      const t = fromId(id)
      // A notification (nbcb=2) claiming success even before markPaid (a replayed or forged-with-a-leaked-key
      // callback). SPEC p56: form POST whose values "are not URL encoded".
      const fields: Record<string, string> = {
        nbcb: '2',
        tranID: t.tranID,
        orderid: t.orderid,
        status: '00',
        domain: opts.merchantId,
        amount: t.amount,
        currency: t.currency,
        appcode: t.appcode || '123456',
        paydate: t.paydate,
        channel: t.channel,
        error_code: '',
        error_desc: '',
        ...override,
      }
      const { skey: given, ...signed } = fields
      // SPEC p21: double MD5 over the posted strings, in this order, with the SECRET key.
      const pre = md5(
        `${signed.tranID}${signed.orderid}${signed.status}${signed.domain}${signed.amount}${signed.currency}`,
      )
      const skey = given ?? md5(`${signed.paydate}${signed.domain}${pre}${signed.appcode}${opts.secretKey}`)
      const rawBody = Object.entries({ ...signed, skey })
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
      return {
        fields: Object.fromEntries(new URLSearchParams(rawBody)),
        rawBody,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper: (cb: CallbackInput) => {
      const skey = flip(cb.fields.skey ?? '')
      return {
        ...cb,
        fields: { ...cb.fields, skey },
        rawBody: cb.rawBody.replace(/(^|&)skey=[^&]*/, `$1skey=${skey}`),
      }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
