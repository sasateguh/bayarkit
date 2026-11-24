// The demo's public meta: link-preview tags, tab icons and the routes that serve them. Every value comes from
// examples/demo/site.json (origin, card type, file names, card size) and i18n (text); these tests read the same files
// and pin the shape: an absolute https og:image on the configured origin, the card in the page's language, a
// content-hash ?v= on every asset URL, and assets that third-party previewers may fetch.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDemo } from '../app.mjs'
import { loadSite } from '../meta.mjs'

const site = JSON.parse(readFileSync(new URL('../site.json', import.meta.url), 'utf8'))
const i18n = (lang) => JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'))
const asset = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url))
const version = (name) => createHash('sha256').update(asset(name)).digest('hex').slice(0, 10)
const fromHtml = (s) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

let demo
beforeAll(async () => {
  demo = await startDemo({ publicOrigin: '' })
}, 60_000)
afterAll(() => demo?.close())

const get = (path) => demo.handle(new Request(`http://demo.test${path}`))
/** `<meta property|name="key" content="…">` → content (unescaped); every occurrence. */
const metas = (html, key) =>
  [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)]
    .filter((m) => m[1] === key)
    .map((m) => fromHtml(m[2]))
const meta = (html, key) => {
  const all = metas(html, key)
  expect(all, key).toHaveLength(1)
  return all[0]
}
const links = (html, rel) =>
  [...html.matchAll(/<link rel="([^"]+)" href="([^"]+)"([^>]*)>/g)]
    .filter((m) => m[1] === rel)
    .map((m) => ({ href: fromHtml(m[2]), rest: m[3] }))

describe('demo public meta', () => {
  it('site.json names a bare https origin, a known card type and an asset file for every icon and language', () => {
    expect(new URL(site.origin).origin).toBe(site.origin)
    expect(site.origin.startsWith('https://')).toBe(true)
    expect(['summary', 'summary_large_image']).toContain(site.twitterCard)
    for (const name of [...Object.values(site.icons), ...Object.values(site.cards)])
      expect(asset(name).length).toBeGreaterThan(0)
    expect(Object.keys(site.cards).sort()).toEqual(['en', 'ms'])
  })

  for (const [path, lang] of [
    ['/', 'ms'],
    ['/en', 'en'],
  ]) {
    it(`${path}: og:image is the ${lang} card, absolute https on the configured origin, with a content hash`, async () => {
      const html = await (await get(path)).text()
      const image = meta(html, 'og:image')
      expect(image).toBe(`${site.origin}/${site.cards[lang]}?v=${version(site.cards[lang])}`)
      expect(new URL(image).protocol).toBe('https:')
      expect(meta(html, 'twitter:image')).toBe(image)
      expect(meta(html, 'og:image:width')).toBe(String(site.cardSize.width))
      expect(meta(html, 'og:image:height')).toBe(String(site.cardSize.height))
      expect(meta(html, 'og:image:type')).toBe('image/png')
      expect(meta(html, 'og:image:alt')).toBe(i18n(lang).og.alt)
      expect(meta(html, 'twitter:card')).toBe(site.twitterCard)
      expect(meta(html, 'og:url')).toBe(`${site.origin}${lang === 'en' ? '/en' : '/'}`)
      expect(meta(html, 'og:locale')).toBe(site.locales[lang])
      expect(meta(html, 'og:site_name')).toBe(site.siteName)
      expect(meta(html, 'og:type')).toBe('website')
      expect(meta(html, 'og:title')).toBe(i18n(lang).title)
      expect(meta(html, 'twitter:title')).toBe(i18n(lang).title)
      expect(meta(html, 'og:description')).toBe(i18n(lang).tagline)
      expect(meta(html, 'twitter:description')).toBe(i18n(lang).tagline)
      // Still never indexed.
      expect(meta(html, 'robots')).toBe('noindex')
    })

    it(`${path}: links the SVG and ICO favicons and the touch icon, each with a content hash`, async () => {
      const html = await (await get(path)).text()
      const icons = links(html, 'icon')
      expect(icons.map((l) => l.href)).toEqual([
        `/${site.icons.svg}?v=${version(site.icons.svg)}`,
        `/${site.icons.ico}?v=${version(site.icons.ico)}`,
      ])
      expect(icons[0].rest).toContain('type="image/svg+xml"')
      expect(icons[1].rest).toContain('sizes="any"')
      expect(links(html, 'apple-touch-icon').map((l) => l.href)).toEqual([
        `/${site.icons.touch}?v=${version(site.icons.touch)}`,
      ])
    })
  }

  it('every page kind carries an absolute og:image (a 404 too)', async () => {
    for (const path of ['/order/NOPE', '/en/no-such-page']) {
      const html = await (await get(path)).text()
      expect(meta(html, 'og:image').startsWith(`${site.origin}/`)).toBe(true)
    }
  })

  it('serves every icon and card by exact name: image type, a week of cache, previewers from any origin allowed', async () => {
    const types = { svg: 'image/svg+xml', ico: 'image/x-icon', png: 'image/png' }
    for (const name of [...Object.values(site.icons), ...Object.values(site.cards)]) {
      for (const path of [`/${name}`, `/${name}?v=${version(name)}`]) {
        const res = await get(path)
        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type')).toBe(types[name.split('.').pop()])
        expect(res.headers.get('cache-control')).toBe('public, max-age=604800, no-transform')
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(Buffer.from(await res.arrayBuffer()).equals(asset(name))).toBe(true)
      }
    }
    // Only the exact names: no folder, no traversal, no other file.
    for (const path of [
      '/assets/og-ms.png',
      '/en/og-ms.png',
      '/..%2fsite.json',
      '/site.json',
      '/og-xx.png',
    ]) {
      expect((await get(path)).status, path).toBe(404)
    }
  })

  it('DEMO_PUBLIC_ORIGIN replaces the origin; a value that is not a bare https origin stops the demo', async () => {
    expect(loadSite({ publicOrigin: 'https://pay.example.my' }).origin).toBe('https://pay.example.my')
    expect(loadSite({ publicOrigin: '' }).origin).toBe(site.origin)
    for (const bad of [
      'http://pay.example.my',
      'https://pay.example.my/',
      'https://pay.example.my/demo',
      'https://pay.example.my?x=1',
      'https://user@pay.example.my',
      '//pay.example.my',
      '/relative',
      'pay.example.my',
      'javascript:alert(1)',
    ]) {
      expect(() => loadSite({ publicOrigin: bad }), bad).toThrow(/origin/)
    }
    await expect(startDemo({ publicOrigin: 'http://pay.example.my' })).rejects.toThrow(/origin/)
  })

  it('refuses a site.json with an unknown card type, an odd file name or a card whose size is not the configured one', () => {
    expect(() => loadSite({ site: { ...site, twitterCard: 'player' } })).toThrow(/twitterCard/)
    expect(() => loadSite({ site: { ...site, icons: { ...site.icons, svg: '../site.json' } } })).toThrow(
      /file name/,
    )
    expect(() => loadSite({ site: { ...site, cards: { ...site.cards, en: 'nope.png' } } })).toThrow()
    expect(() => loadSite({ site: { ...site, cardSize: { width: 1200, height: 600 } } })).toThrow(/1200x630/)
    const { en: _, ...msOnly } = site.cards
    expect(() => loadSite({ site: { ...site, cards: msOnly } })).toThrow(/en/)
  })
})
