/**
 * Sending the customer to the payment page. Most gateways take a redirect; some (iPay88, eGHL, Fiuu) expect the
 * browser to POST a form. `checkoutResponse` returns whichever the payment needs, so a checkout route never branches
 * on the gateway.
 */
import { GatewayError } from './errors.js'
import type { CreatedPayment, PaymentForm } from './types.js'

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

/** The page's only script. Its hash is in the CSP below; change one and the core test fails until both match. */
export const AUTO_POST_SCRIPT = 'document.forms[0].submit()'
const AUTO_POST_SCRIPT_HASH = 'sha256-ePniVEkSivX/c7XWBGafqh8tSpiRrKiqYeqbG7N1TOE='

function httpUrl(value: unknown, what: string): string {
  let parsed: URL
  try {
    parsed = new URL(String(value))
  } catch {
    throw new GatewayError(`${what} is not a URL`, 'bayarkit', 0, 'INVALID_URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new GatewayError(`${what} must be http(s)`, 'bayarkit', 0, 'INVALID_URL')
  return parsed.href
}

/**
 * A page that POSTs `form`. The button stays visible so the customer can continue when the browser or your own CSP
 * blocks the script; every name and value is HTML-escaped.
 */
export function autoPostHtml(form: PaymentForm, label = 'Continue to payment'): string {
  const action = httpUrl(form.action, 'form action')
  const inputs = Object.entries(form.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(label)}</title></head><body><form method="post" action="${escapeHtml(action)}" accept-charset="UTF-8">${inputs}<button type="submit">${escapeHtml(label)}</button></form><script>${AUTO_POST_SCRIPT}</script></body></html>`
}

/**
 * The response that sends the customer to pay: a 303 redirect to `payment.url`, or, when the gateway wants a POST, a
 * page that submits `payment.form`. `label` is the button text shown if scripts are blocked (use your site's language).
 */
export function checkoutResponse(payment: Pick<CreatedPayment, 'url' | 'form'>, label?: string): Response {
  if (!payment.form) return Response.redirect(httpUrl(payment.url, 'payment url'), 303)
  return new Response(autoPostHtml(payment.form, label), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The fields are signed for one payment: never cache or index them.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      // No Referrer-Policy: iPay88 checks the Referer against the merchant's registered site.
      'content-security-policy': `default-src 'none'; script-src '${AUTO_POST_SCRIPT_HASH}'; base-uri 'none'; frame-ancestors 'none'`,
    },
  })
}
