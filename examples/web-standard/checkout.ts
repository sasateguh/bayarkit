/**
 * Checkout + callback with Web-standard handlers (drop into Next.js `app/api/.../route.ts`, Hono, Bun or Deno).
 * Swap `toyyibpay(...)` for `bayarcash(...)` and nothing else changes — that is the point of bayarkit.
 */
import { confirmPayment, type Gateway, readCallback } from '@bayarkit/core'
import { toyyibpay } from '@bayarkit/toyyibpay'

const gateway: Gateway = toyyibpay({
  secretKey: process.env.TOYYIBPAY_SECRET_KEY ?? '',
  categoryCode: process.env.TOYYIBPAY_CATEGORY_CODE ?? '',
  environment: process.env.TOYYIBPAY_ENV === 'production' ? 'production' : 'sandbox',
})

// Your own store. Shown as an in-memory map; use your database.
const orders = new Map<
  string,
  { reference: string; amount: number; status: 'unpaid' | 'paid'; paymentId?: string }
>()

/** POST /checkout — create the payment and send the customer to the gateway. */
export async function checkout(request: Request): Promise<Response> {
  const { amount, email, name } = (await request.json()) as { amount: number; email?: string; name?: string }
  // One reference per ATTEMPT: a stale callback from an earlier attempt then cannot match this one.
  const reference = `ORD${Date.now()}`
  orders.set(reference, { reference, amount, status: 'unpaid' })
  const payment = await gateway.createPayment({
    reference,
    amount,
    description: 'Order at My Shop',
    customer: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
    returnUrl: 'https://shop.example/thank-you',
    callbackUrl: 'https://shop.example/api/payment/callback',
  })
  const order = orders.get(reference)
  if (order) order.paymentId = payment.id
  return Response.redirect(payment.url, 303)
}

/** POST /api/payment/callback — the gateway's server-to-server notification. */
export async function callback(request: Request): Promise<Response> {
  const cb = await readCallback(request)
  const order = [...orders.values()].find(
    (o) => o.reference === (cb.fields.order_id ?? cb.fields.order_number),
  )
  if (!order) return new Response('unknown order', { status: 404 })
  if (order.status === 'paid') return new Response('OK') // gateways retry; answer the same way
  const result = await confirmPayment(gateway, cb, { reference: order.reference, amount: order.amount })
  if (result.ok) order.status = 'paid'
  // Log result.reason / result.detail when !ok; never mark paid from the return URL.
  return new Response('OK')
}
