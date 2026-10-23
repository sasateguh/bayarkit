/**
 * The conformance suite. Every adapter runs it against its fake (always) and against the real sandbox (when keys are
 * present, which is what turns `evidence.kind` into "measured"). Adding a gateway = an adapter + a fake that pass this.
 */
import { type CreatePaymentInput, confirmPayment, type Gateway, GatewayError } from '@bayarkit/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FakeGateway } from './fakes/types.js'

export interface ConformanceSetup {
  gateway: Gateway
  fake: FakeGateway
}

let counter = 0
export function sampleInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  counter += 1
  return {
    reference: `ORDER${Date.now()}${counter}`,
    amount: 1050,
    description: 'Conformance test order',
    customer: { name: 'Ali bin Abu', email: 'ali@example.com', phone: '0123456789' },
    returnUrl: 'https://shop.example/return',
    callbackUrl: 'https://shop.example/callback',
    ...overrides,
  }
}

export function gatewayConformance(name: string, setup: () => Promise<ConformanceSetup>): void {
  describe(`${name}: bayarkit conformance`, () => {
    let gateway: Gateway
    let fake: FakeGateway

    beforeAll(async () => {
      ;({ gateway, fake } = await setup())
    })
    afterAll(async () => {
      await fake?.close()
    })

    it('declares where its behaviour comes from', () => {
      expect(gateway.info.name).toMatch(/^[a-z0-9-]+$/)
      expect(gateway.info.minimumAmount).toBeGreaterThan(0)
      expect(['measured', 'docs']).toContain(gateway.info.evidence.kind)
      expect(gateway.info.evidence.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('creates a payment with an id and a redirect URL', async () => {
      const created = await gateway.createPayment(sampleInput())
      expect(created.id).not.toBe('')
      expect(created.url).toMatch(/^https?:\/\//)
    })

    it('rejects an amount below its minimum before calling the gateway', async () => {
      const amount = gateway.info.minimumAmount - 1
      await expect(gateway.createPayment(sampleInput({ amount }))).rejects.toBeInstanceOf(GatewayError)
    })

    it('rejects a non-integer amount', async () => {
      await expect(gateway.createPayment(sampleInput({ amount: 10.5 }))).rejects.toBeInstanceOf(GatewayError)
    })

    it('reports an unpaid payment as not paid', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      const cb = gateway.verifyCallback(fake.callbackFor(created.id))
      expect(cb).not.toBeNull()
      const record = await gateway.getPayment(cb?.id ?? '')
      expect(record.status).not.toBe('paid')
    })

    it('confirms a paid payment from its callback', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const result = await confirmPayment(gateway, fake.callbackFor(created.id), input)
      expect(result).toMatchObject({ ok: true })
      if (result.ok) {
        expect(result.payment.reference).toBe(input.reference)
        expect(result.payment.amount).toBe(input.amount)
        expect(result.payment.currency).toBe('MYR')
      }
    })

    it('refuses a callback whose signature was tampered with', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const body = fake.callbackFor(created.id)
      const sig = 'hash' in body ? 'hash' : 'checksum'
      const forged = { ...body, [sig]: (body[sig] ?? '').replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }
      expect(await confirmPayment(gateway, forged, input)).toMatchObject({
        ok: false,
        reason: 'invalid_signature',
      })
    })

    it('refuses a correctly signed callback when the gateway says it is not paid (replay / leaked key)', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      expect(await confirmPayment(gateway, fake.callbackFor(created.id), input)).toMatchObject({
        ok: false,
        reason: 'not_paid',
      })
    })

    it('refuses a paid payment whose amount differs from what you charged', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const result = await confirmPayment(gateway, fake.callbackFor(created.id), {
        ...input,
        amount: input.amount + 1,
      })
      expect(result).toMatchObject({ ok: false, reason: 'mismatch' })
    })

    it('refuses a paid payment that belongs to a different order', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const result = await confirmPayment(gateway, fake.callbackFor(created.id), {
        ...input,
        reference: 'SOMEONE-ELSE',
      })
      expect(result).toMatchObject({ ok: false, reason: 'mismatch' })
    })

    it('never throws on a malformed callback body', () => {
      for (const body of [
        {},
        { hash: 'x' },
        { checksum: 'zz', transaction_id: '1' },
        { billcode: '../../etc' },
      ]) {
        expect(() => gateway.verifyCallback(body as Record<string, string>)).not.toThrow()
        expect(gateway.verifyCallback(body as Record<string, string>)).toBeNull()
      }
    })

    it('confirming the same callback twice gives the same answer (gateways retry callbacks)', async () => {
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const body = fake.callbackFor(created.id)
      const first = await confirmPayment(gateway, body, input)
      const second = await confirmPayment(gateway, body, input)
      expect(second).toEqual(first)
    })
  })
}
