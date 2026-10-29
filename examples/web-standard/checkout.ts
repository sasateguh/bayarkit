/**
 * Checkout + callback with Web-standard handlers (drop into Next.js `app/api/.../route.ts`, Hono, Bun or Deno).
 * The handlers take any `Gateway`: switching gateways changes the adapter and its keys, never these two functions.
 * `test/checkout.test.ts` runs them unchanged against the fake of every gateway.
 */
import { checkoutResponse, confirmPayment, type Gateway, readCallback } from '@bayarkit/core'
import { toyyibpay } from '@bayarkit/toyyibpay'

export interface Order {
  reference: string
  amount: number
  status: 'unpaid' | 'paid'
  paymentId?: string
}

export function paymentRoutes(gateway: Gateway, orders: Map<string, Order>) {
  return {
    /** POST /checkout — create the payment and send the customer to the gateway. */
    async checkout(request: Request): Promise<Response> {
      const { amount, email, name } = (await request.json()) as {
        amount: number
        email?: string
        name?: string
      }
      // One reference per ATTEMPT: a stale callback from an earlier attempt then cannot match this one.
      // Letters and digits only: the common subset every gateway accepts (Gkash, for one, wants upper case).
      const reference = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`
      const order: Order = { reference, amount, status: 'unpaid' }
      orders.set(reference, order)
      const payment = await gateway.createPayment({
        reference,
        amount,
        description: 'Order at My Shop',
        customer: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
        returnUrl: 'https://shop.example/thank-you',
        callbackUrl: 'https://shop.example/api/payment/callback',
      })
      order.paymentId = payment.id
      // A 303 redirect for most gateways; a self-submitting POST page for iPay88, eGHL and Fiuu.
      return checkoutResponse(payment, 'Continue to payment')
    },

    /** POST /api/payment/callback — the gateway's server-to-server notification. */
    async callback(request: Request): Promise<Response> {
      const cb = await readCallback(request)
      // Find the order from a callback whose signature checks out: by your reference, which most gateways send
      // back, else by the payment id saved at checkout (Billplz sends no reference; its id stays the same).
      const verified = await gateway.verifyCallback(cb)
      const order = !verified
        ? undefined
        : verified.reference
          ? orders.get(verified.reference)
          : [...orders.values()].find((o) => o.paymentId === verified.id)
      if (!order) return new Response('unknown order', { status: 404 })
      if (order.status === 'paid') return new Response('OK') // gateways retry; answer the same way
      const result = await confirmPayment(gateway, cb, { reference: order.reference, amount: order.amount })
      if (result.ok) order.status = 'paid'
      // Log result.reason / result.detail when !ok; never mark paid from the return URL.
      return new Response('OK')
    },
  }
}

// Your own store. Shown as an in-memory map; use your database.
const orders = new Map<string, Order>()

export const { checkout, callback } = paymentRoutes(
  toyyibpay({
    secretKey: process.env.TOYYIBPAY_SECRET_KEY ?? '',
    categoryCode: process.env.TOYYIBPAY_CATEGORY_CODE ?? '',
    environment: process.env.TOYYIBPAY_ENV === 'production' ? 'production' : 'sandbox',
  }),
  orders,
)
