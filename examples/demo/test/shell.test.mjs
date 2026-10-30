// The page shell around every demo page: the "Sasa Teguh can install this" seal (from docs/support.json, never from
// code), the no-JavaScript theme switch, self-hosted fonts, and the headers that keep the page script-free.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { supportFor } from '../../../tools/support.mjs'
import { startDemo } from '../app.mjs'

const config = JSON.parse(readFileSync(new URL('../../../docs/support.json', import.meta.url), 'utf8'))
const css = readFileSync(new URL('../demo.css', import.meta.url), 'utf8')

let demo
beforeAll(async () => {
  demo = await startDemo({ support: config })
}, 60_000)
afterAll(() => demo?.close())

const base = 'http://demo.test'
const get = (path, headers = {}) => demo.handle(new Request(base + path, { headers }))
const post = (path, fields) =>
  demo.handle(
    new Request(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  )

/** The HTML of the seal element (`class="seal"`), or null. */
const seal = (html) => /<aside class="seal"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? null
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))

/** One page of every kind, in one language: home, home with an error, payment, order, missing order, unknown path. */
async function everyPage(prefix) {
  const created = await post(`${prefix}/checkout`, { gateway: 'toyyibpay', amount: '3.00' })
  const payPath = created.headers.get('location')
  const pay = await get(payPath)
  const paid = await post(payPath, { action: 'pay' })
  return {
    home: await get(`${prefix}/`),
    error: await post(`${prefix}/checkout`, { gateway: 'toyyibpay', amount: 'abc' }),
    pay,
    order: await get(paid.headers.get('location')),
    missing: await get(`${prefix}/order/NOPE`),
    unknown: await get(`${prefix}/no-such-page`),
  }
}

describe('demo seal (docs/support.json)', () => {
  for (const [lang, prefix] of [
    ['ms', ''],
    ['en', '/en'],
  ]) {
    it(`is on every kind of page in ${lang}, with exactly the three contact links from the config`, async () => {
      const offer = supportFor(config, lang)
      const expected = offer.links.map((l) => l.href)
      for (const [kind, res] of Object.entries(await everyPage(prefix))) {
        const html = await res.text()
        expect(res.headers.get('content-type'), kind).toContain('text/html')
        expect(html, kind).toContain(`<html lang="${lang}"`)
        const s = seal(html)
        expect(s, `${kind}: seal`).not.toBeNull()
        expect(hrefs(s), kind).toEqual(expected)
        expect(s, kind).toContain(offer.seal)
        // Every contact link on the page is one of the three (the footer repeats them; nothing else may appear).
        const contacts = hrefs(html).filter((h) => /^mailto:|wa\.me|sasateguh\.com\/(ms\/)?contact/.test(h))
        expect(
          contacts.every((h) => expected.includes(h)),
          kind,
        ).toBe(true)
        // The seal is not part of the simulated gateway panel.
        expect(html.indexOf('<aside class="seal"'), kind).toBeLessThan(html.indexOf('<main'))
      }
    })
  }

  it('comes only from the config: enabled:false removes it, and a bad config refuses to start', async () => {
    const off = await startDemo({ support: { ...config, enabled: false } })
    try {
      const html = await (await off.handle(new Request(`${base}/`))).text()
      expect(seal(html)).toBeNull()
      expect(html).not.toContain('admin@sasateguh.com')
      expect(html).not.toContain('wa.me')
    } finally {
      await off.close()
    }
    const bad = { ...config, contact: { ...config.contact, email: 'someone@gmail.com' } }
    await expect(startDemo({ support: bad })).rejects.toThrow(/cannot be published/)
  })

  it('never floats over the page: no fixed or sticky positioning anywhere in the stylesheet', () => {
    expect(css).not.toMatch(/position\s*:\s*(fixed|sticky)/)
    expect(css).not.toMatch(/backdrop-filter/)
  })
})

describe('theme switch (no JavaScript: a link, a cookie, a relative redirect)', () => {
  it('sets the cookie and sends the visitor back where they were', async () => {
    const res = await get('/theme?set=dark&back=%2Fen%2Forder%2FDEMO0123')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/en/order/DEMO0123')
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toMatch(/^theme=dark; /)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toMatch(/Max-Age=31536000/)
    expect(cookie).not.toContain('Secure')
    const system = await get('/en/theme?set=system&back=%2Fen%2F')
    expect(system.headers.get('location')).toBe('/en/')
    expect(system.headers.get('set-cookie')).toMatch(/^theme=; .*Max-Age=0/)
  })

  it('refuses to redirect anywhere but a local path (no open redirect)', async () => {
    for (const back of [
      '//evil.example/',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '/%0d%0aSet-Cookie:x=1',
      '/a b',
      '',
      `/${'a'.repeat(300)}`,
    ]) {
      const res = await get(`/theme?set=light&back=${encodeURIComponent(back)}`)
      expect(res.status, back).toBe(303)
      expect(res.headers.get('location'), back).toBe('/')
    }
    const odd = await get('/theme?set=purple&back=%2F')
    expect(odd.status).toBe(303)
    expect(odd.headers.get('set-cookie')).toBeNull()
  })

  it('marks the page with the chosen theme and ignores a broken cookie', async () => {
    expect(await (await get('/', { cookie: 'theme=dark' })).text()).toContain('data-theme="dark"')
    expect(await (await get('/', { cookie: 'a=1; theme=light' })).text()).toContain('data-theme="light"')
    for (const cookie of ['theme="><script>', 'theme=darkest', 'theme=', ''])
      expect(await (await get('/', { cookie })).text(), cookie).toContain('data-theme="system"')
  })

  it('the switch links point back at the page they are on, and the active one is marked', async () => {
    const html = await (await get('/en/', { cookie: 'theme=light' })).text()
    expect(html).toContain('href="/theme?set=dark&amp;back=%2Fen%2F"')
    expect(html).toMatch(/href="\/theme\?set=light[^"]*" aria-current="true"/)
  })

  it('adds Secure to the cookie when the host serves HTTPS (COOKIE_SECURE=1)', async () => {
    const secure = await startDemo({ support: config, cookieSecure: true })
    try {
      const res = await secure.handle(new Request(`${base}/theme?set=dark&back=%2F`))
      expect(res.headers.get('set-cookie')).toContain('; Secure')
    } finally {
      await secure.close()
    }
  })
})

describe('fonts and headers', () => {
  it('serves the self-hosted fonts, and the CSP allows only those (still no scripts)', async () => {
    const html = await (await get('/')).text()
    const fonts = [...css.matchAll(/url\("(\/fonts\/[a-z0-9-]+\.woff2)"\)/g)].map((m) => m[1])
    expect(fonts.length).toBeGreaterThanOrEqual(1)
    expect(fonts.length).toBeLessThanOrEqual(2)
    for (const f of fonts) {
      const res = await get(f)
      expect(res.status, f).toBe(200)
      expect(res.headers.get('content-type'), f).toBe('font/woff2')
      expect(res.headers.get('cross-origin-resource-policy'), f).toBe('same-origin')
      expect((await res.arrayBuffer()).byteLength, f).toBeGreaterThan(1000)
    }
    expect((await get('/fonts/..%2Fdemo.css')).status).toBe(404)
    expect((await get('/fonts/nope.woff2')).status).toBe(404)
    const csp = (await get('/')).headers.get('content-security-policy')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("font-src 'self'")
    expect(csp).not.toContain('script-src')
    expect(html).not.toMatch(/<script|\sstyle="|\son[a-z]+="/i)
  })

  it('keeps what the deploy health check looks for', async () => {
    expect(await (await get('/')).text()).toContain('value="toyyibpay"')
    expect((await get('/en')).status).toBe(200)
    expect((await get('/demo.css')).status).toBe(200)
  })
})
