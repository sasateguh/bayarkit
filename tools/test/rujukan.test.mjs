import { describe, expect, it } from 'vitest'
import { normalise } from '../rujukan.mjs'

describe('rujukan normalise', () => {
  it('makes links to the page’s own site relative, so docs flipping between the two is not a change', () => {
    const url = 'https://curlec.com/docs/webhooks/validate-test.md'
    const absolute =
      'See [SDKs](https://curlec.com/docs/payments/server-integration.md) and <a href="https://curlec.com/x">x</a>'
    const relative = 'See [SDKs](/docs/payments/server-integration.md) and <a href="/x">x</a>'
    expect(normalise(absolute, 'text/markdown', url)).toBe(normalise(relative, 'text/markdown', url))
  })

  it('keeps everything else: other sites, bare URLs in text, and real wording changes', () => {
    const url = 'https://docs.hitpayapp.com/apis/guide/events.md'
    expect(normalise('[a](https://example.com/p)', '', url)).toBe('[a](https://example.com/p)')
    expect(normalise('POST https://docs.hitpayapp.com/x', '', url)).toBe('POST https://docs.hitpayapp.com/x')
    expect(normalise('fee returned', '', url)).not.toBe(normalise('fee returned empty', '', url))
  })

  it('strips HTML to visible text and collapses whitespace', () => {
    expect(normalise('<html><script>x()</script><p>Hello\n  <b>world</b></p></html>', 'text/html')).toBe(
      'Hello world',
    )
  })
})
