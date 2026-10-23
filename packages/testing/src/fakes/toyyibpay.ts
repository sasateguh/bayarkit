/**
 * A fake toyyibPay that answers in the shapes MEASURED on the sandbox (10 October 2026), not the documented ones:
 * leading tabs + text/html, "No data found!" for a bill without transactions, bracketed error codes, `{CategoryName}`.
 * A fake written from the docs passed bugs that were live in production twice in one day; keep this one honest.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

export interface FakeToyyibPay extends FakeGateway {
  /** Every request received, for assertions (fields as posted). */
  requests: { path: string; fields: Record<string, string>; contentType: string | undefined }[]
}

export async function startFakeToyyibPay(opts: {
  secretKey: string
  categoryCode: string
}): Promise<FakeToyyibPay> {
  let n = 0
  const bills = new Map<
    string,
    { fields: Record<string, string>; txs: Record<string, string>[]; inactive: boolean }
  >()
  const requests: FakeToyyibPay['requests'] = []

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => {
      const fields = Object.fromEntries(new URLSearchParams(body))
      const path = (req.url ?? '').replace('/index.php/api/', '')
      requests.push({ path, fields, contentType: req.headers['content-type'] })
      const text = (t: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
        res.end(`\t\t\t\t${t}`)
      }
      const json = (o: unknown) => text(JSON.stringify(o))

      if (path === 'createBill') {
        if (fields.userSecretKey !== opts.secretKey) return text('[KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE]')
        if (fields.categoryCode !== opts.categoryCode) return text('[CATEGORY-NOT-MATCH]')
        if (fields.billPayorInfo === '1' && !fields.billEmail) {
          return json({ status: 'error', msg: 'billEmail parameter is empty' })
        }
        // Message measured; envelope assumed to match the billEmail error above.
        if (Number(fields.billAmount) < 100)
          return json({ status: 'error', msg: 'billAmount should more than RM1.00' })
        const code = `fk${++n}tp`
        bills.set(code, { fields, txs: [], inactive: false })
        return json([{ BillCode: code }])
      }
      if (path === 'getBillTransactions') {
        const bill = bills.get(fields.billCode ?? '')
        return bill?.txs.length ? json(bill.txs) : text('No data found!')
      }
      if (path === 'inactiveBill') {
        const bill = bills.get(fields.billCode ?? '')
        if (fields.secretKey !== opts.secretKey || !bill)
          return json({ status: 'error', result: 'Invalid Secret Key!' })
        if (bill.inactive) return json({ status: 'failed', result: 'Bill is inactive' })
        bill.inactive = true
        return json({ status: 'success', result: 'Bill status changed to inactive' })
      }
      if (path === 'getCategoryDetails') {
        if (fields.userSecretKey === opts.secretKey && fields.categoryCode === opts.categoryCode) {
          return json({ CategoryName: 'Fake category', categoryDescription: 'x', categoryStatus: '1' })
        }
        return text('')
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const bill = (code: string) => {
    const b = bills.get(code)
    if (!b) throw new Error(`fake toyyibPay: no bill ${code}`)
    return b
  }

  return {
    url,
    requests,
    markPaid(code) {
      const b = bill(code)
      // Shape of a real test-bank payment: the docs sample plus transactionCharge/chargeOn (measured).
      b.txs.push({
        billName: b.fields.billName ?? '',
        billStatus: '0',
        billpaymentStatus: '1',
        billpaymentChannel: 'FPX',
        billpaymentAmount: (Number(b.fields.billAmount) / 100).toFixed(2),
        billpaymentInvoiceNo: `TP${Date.now()}${b.txs.length}`,
        billPaymentDate: '10-10-2026 10:50:07',
        billExternalReferenceNo: b.fields.billExternalReferenceNo ?? '',
        transactionCharge: '1.00',
        chargeOn: 'Amount',
      })
    },
    callbackFor(code, override = {}) {
      const b = bill(code)
      const fields: Record<string, string> = {
        refno: `TP${code}`,
        status: '1',
        reason: 'Approved',
        billcode: code,
        order_id: b.fields.billExternalReferenceNo ?? '',
        amount: (Number(b.fields.billAmount) / 100).toFixed(2),
        status_id: '1',
        msg: 'ok',
        transaction_id: `TP${code}`,
        ...override,
      }
      const hash = createHash('md5')
        .update(`${opts.secretKey}${fields.status}${fields.order_id}${fields.refno}ok`)
        .digest('hex')
      // Measured: toyyibPay posts this as multipart/form-data; the signature is the `hash` field.
      return { fields: { ...fields, hash: override.hash ?? hash }, rawBody: '', headers: {} }
    },
    tamper: (cb) => ({ ...cb, fields: { ...cb.fields, hash: flip(cb.fields.hash ?? '') } }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
