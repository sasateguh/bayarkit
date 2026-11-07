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

// Synthetic samples shaped like the real noise (no third-party text): a docs site rewrote its front-matter date, and
// another moved headings from bold to `[tab]`/`[accordion]`/`[card]` markers inside blockquotes.
describe('rujukan normalise: format and metadata noise', () => {
  const md = 'text/markdown'
  const page = (stamp, body) =>
    `---\ntitle: "Sign events"\nlast_modified: "${stamp}"\nlanguage: "en"\n---\n\n# Sign events\n\n${body}\n`

  it('ignores a named timestamp in the front matter', () => {
    const before = page('2026-10-23T12:57:18+02:00', 'Hash the body with your key.')
    const after = page('2026-11-06T17:06:40+01:00', 'Hash the body with your key.')
    expect(normalise(after, md)).toBe(normalise(before, md))
    for (const key of ['lastmod', 'date_modified', 'updated']) {
      const a = before.replace('last_modified', key)
      const b = after.replace('last_modified', key)
      expect(normalise(b, md)).toBe(normalise(a, md))
    }
  })

  it('treats **bold** and [tab]/[accordion]/[card] markers in blockquotes as the same text', () => {
    const bold =
      '**Sandbox**\n\n```\nPOST https://api.example.test/v1/pay\n```\n\n**Option 1: Redirect**\n\nSend the user.'
    const tabs =
      '> [tab] Sandbox\n>\n> ```\n> POST https://api.example.test/v1/pay\n> ```\n\n> [accordion] Option 1: Redirect\n> > Send the user.\n[/accordion]\n> [card] Go live'
    expect(normalise(tabs, md)).toBe(`${normalise(bold, md)} Go live`)
    expect(normalise('**2.5 Set up *(Optional)*** Then', md)).toBe('2.5 Set up *(Optional)* Then')
  })

  it('is idempotent, so a stored (already normalised) copy can be compared with a fresh page', () => {
    const raw = `${page('2026-10-23T12:57:18+02:00', '> **For you:** read\n> [tab] One\n> > * `a`')}\n**[2. Test](/x)**`
    const once = normalise(raw, md)
    expect(normalise(once, md)).toBe(once)
  })

  it('still sees content changes: words, numbers, a body timestamp, code operators', () => {
    const t = (s) => normalise(s, md)
    expect(t(page('2026-10-23T12:57:18+02:00', 'Hash the body.'))).not.toBe(
      t(page('2026-10-23T12:57:18+02:00', 'Hash the raw body.')),
    )
    expect(t('| amount | 100 |')).not.toBe(t('| amount | 1000 |'))
    expect(t('Intro\n\nlast_modified: "2026-10-23T12:57:18+02:00"')).not.toBe(
      t('Intro\n\nlast_modified: "2026-11-06T17:06:40+01:00"'),
    )
    // Front matter only at the very top: a later `---` block is body text.
    expect(t('Intro\n---\nupdated: 2026-10-23\n---')).not.toBe(t('Intro\n---\nupdated: 2026-11-06\n---'))
    expect(t('if (a > 0) {')).not.toBe(t('if (a >= 0) {'))
    expect(t('if (a > 0) {')).not.toBe(t('if (a < 0) {'))
    expect(t('/** Signs the body. */ sign(**opts)')).toBe('/** Signs the body. */ sign(**opts)')
    expect(t('[tab](https://example.test/tab) [card]: /x')).toBe('[tab](https://example.test/tab) [card]: /x')
  })
})
