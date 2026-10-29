/**
 * The optional parts of the conformance suite (an async `verifyCallback`, refunds) run here against an in-memory toy
 * gateway, so they are exercised before any real adapter needs them. The toy is not a gateway model: it only does
 * what the suite asks, the way an adapter that verifies through its API and refunds would.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type CallbackInput,
  checkRefundAmount,
  type Gateway,
  GatewayError,
  type PaymentRecord,
  type RefundRecord,
  type VerifiedCallback,
} from '@bayarkit/core'
import { describe, expect, it } from 'vitest'
import { gatewayConformance } from '../src/conformance.js'
import { type FakeGateway, flip } from '../src/fakes/types.js'

const KEY = 'toy-signing-key'
const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex')

interface ToyPayment {
  id: string
  reference: string
  amount: number
  paid: boolean
  refunded: number
}

type ToyGateway = Gateway<Promise<VerifiedCallback | null>>

function toy(): { gateway: ToyGateway; fake: FakeGateway } {
  const payments = new Map<string, ToyPayment>()
  let n = 0
  const find = (id: string) => {
    const p = payments.get(id)
    if (!p) throw new GatewayError('no such payment', 'toy', 404)
    return p
  }

  const gateway: ToyGateway = {
    info: { name: 'toy', minimumAmount: 100, evidence: { kind: 'docs', date: '2026-10-29', source: 'test' } },
    async createPayment(input) {
      if (!Number.isSafeInteger(input.amount) || input.amount < 100)
        throw new GatewayError('bad amount', 'toy', 0)
      n += 1
      const id = `toy_${n}`
      payments.set(id, { id, reference: input.reference, amount: input.amount, paid: false, refunded: 0 })
      return { id, url: `https://pay.toy.example/${id}`, raw: null }
    },
    async getPayment(id): Promise<PaymentRecord> {
      const p = find(id)
      return {
        id,
        reference: p.reference,
        status: p.paid ? 'paid' : 'pending',
        amount: p.amount,
        currency: 'MYR',
        raw: null,
      }
    },
    // Async on purpose: the shape PayPal's verify-through-the-API needs.
    async verifyCallback(cb: CallbackInput): Promise<VerifiedCallback | null> {
      await Promise.resolve()
      const got = cb?.headers?.['x-toy-signature']
      const body = cb?.rawBody
      if (typeof got !== 'string' || typeof body !== 'string' || !body) return null
      const want = sign(body)
      if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null
      try {
        const json = JSON.parse(body) as Record<string, string>
        return { id: json.id ?? '', reference: json.reference ?? '', claimedStatus: 'paid', raw: json }
      } catch {
        return null
      }
    },
    async refundPayment(input): Promise<RefundRecord> {
      const p = find(input.paymentId)
      if (!p.paid) throw new GatewayError('payment is not paid', 'toy', 0)
      checkRefundAmount('toy', input, p.amount - p.refunded)
      p.refunded += input.amount
      return {
        id: `re_${p.id}_${p.refunded}`,
        paymentId: p.id,
        status: 'succeeded',
        amount: input.amount,
        currency: 'MYR',
        raw: null,
      }
    },
  }

  const fake: FakeGateway = {
    url: 'https://pay.toy.example',
    markPaid: (id) => {
      find(id).paid = true
    },
    callbackFor(id, override = {}) {
      const p = find(id)
      const fields = { id, reference: p.reference, status: 'paid', ...override }
      const rawBody = JSON.stringify(fields)
      return {
        fields,
        rawBody,
        headers: { 'content-type': 'application/json', 'x-toy-signature': sign(rawBody) },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: { ...cb.headers, 'x-toy-signature': flip(cb.headers['x-toy-signature'] ?? '') },
    }),
    close: async () => {},
  }
  return { gateway, fake }
}

gatewayConformance('toy (async verify, refunds)', async () => toy())

describe('toy gateway (the cases above are not vacuous)', () => {
  it('a gateway without refundPayment is a valid Gateway (refunds stay optional)', () => {
    const { gateway } = toy()
    const { refundPayment: _, ...withoutRefunds } = gateway
    const plain: ToyGateway = withoutRefunds
    expect(plain.refundPayment).toBeUndefined()
  })

  it('a second refund cannot take more than is left', async () => {
    const { gateway, fake } = toy()
    const created = await gateway.createPayment({
      reference: 'R1',
      amount: 1000,
      description: 'x',
      returnUrl: 'https://x',
      callbackUrl: 'https://x',
    })
    fake.markPaid(created.id)
    await gateway.refundPayment?.({ paymentId: created.id, amount: 600 })
    await expect(gateway.refundPayment?.({ paymentId: created.id, amount: 401 })).rejects.toThrow(
      'toy: refund of 401 sen exceeds the 400 sen paid',
    )
  })
})
