import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AUTO_POST_SCRIPT } from '../src/checkout.js'
import { autoPostHtml, checkoutResponse, GatewayError, type PaymentForm } from '../src/index.js'

const form: PaymentForm = {
  method: 'POST',
  action: 'https://pay.example/entry',
  fields: { RefNo: 'ORD1', Signature: 'abc"><script>alert(1)</script>', 'we"ird': "it's & <b>" },
}

describe('checkoutResponse', () => {
  it('redirects with 303 when the gateway takes a redirect', () => {
    const res = checkoutResponse({ url: 'https://pay.example/bill/1' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://pay.example/bill/1')
  })

  it('serves an auto-posting page when the gateway wants a form, never cached or indexed', async () => {
    const res = checkoutResponse({ url: form.action, form })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    // iPay88 checks the Referer, so the page must not strip it.
    expect(res.headers.get('referrer-policy')).toBeNull()
    const html = await res.text()
    expect(html).toContain('<form method="post" action="https://pay.example/entry"')
    expect(html).toContain('<input type="hidden" name="RefNo" value="ORD1">')
  })

  it('allows exactly its own script in the CSP', () => {
    const csp = checkoutResponse({ url: form.action, form }).headers.get('content-security-policy') ?? ''
    const hash = createHash('sha256').update(AUTO_POST_SCRIPT).digest('base64')
    expect(csp).toContain(`script-src 'sha256-${hash}'`)
    expect(csp).toContain("default-src 'none'")
  })

  it('escapes every field name and value', () => {
    const html = autoPostHtml(form)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('value="abc&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(html).toContain('name="we&quot;ird" value="it&#39;s &amp; &lt;b&gt;"')
    expect(html.match(/<script>/g)).toHaveLength(1)
  })

  it('keeps a visible button with your label for browsers that block the script', () => {
    const html = autoPostHtml(form, 'Teruskan ke pembayaran')
    expect(html).toContain('<button type="submit">Teruskan ke pembayaran</button>')
    expect(html).not.toContain('<noscript>')
  })

  it('refuses a form or redirect that is not http(s)', () => {
    expect(() => checkoutResponse({ url: 'javascript:alert(1)' })).toThrow(GatewayError)
    expect(() => checkoutResponse({ url: 'x', form: { ...form, action: 'javascript:alert(1)' } })).toThrow(
      GatewayError,
    )
    expect(() => checkoutResponse({ url: 'not a url' })).toThrow(GatewayError)
  })
})
