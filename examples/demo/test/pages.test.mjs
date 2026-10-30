// The pages after the home page: the simulated payment page (it must not look like a real bank), the order page (each
// check readable without colour) and the error pages (404, 503). Shapes and classes are checked, never the wording,
// which lives in i18n/<lang>.json.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDemo } from '../app.mjs'

// Both files the demo serves as /demo.css.
const css = ['../demo.css', '../pages.css']
  .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
  .join('\n')
const LANGS = {
  ms: JSON.parse(readFileSync(new URL('../i18n/ms.json', import.meta.url), 'utf8')),
  en: JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8')),
}

let demo
beforeAll(async () => {
  demo = await startDemo()
}, 60_000)
afterAll(() => demo?.close())

const base = 'http://demo.test'
const get = (path) => demo.handle(new Request(base + path))
const post = (path, fields) =>
  demo.handle(
    new Request(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  )
const main = (html) => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? ''
const count = (html, re) => (html.match(re) ?? []).length

/** A new order on a fake gateway: the payment page's path and HTML. */
async function newOrder(prefix, gateway = 'toyyibpay') {
  const created = await post(`${prefix}/checkout`, { gateway, amount: '4.20' })
  const path = created.headers.get('location')
  return { path, html: await (await get(path)).text() }
}

/** The order page after one scenario. */
async function scenario(prefix, action) {
  const { path } = await newOrder(prefix)
  const done = await post(path, { action })
  return (await get(done.headers.get('location'))).text()
}

const LANG_CASES = [
  ['ms', ''],
  ['en', '/en'],
]

describe('simulated payment page', () => {
  for (const [lang, prefix] of LANG_CASES) {
    it(`is framed as a simulated gateway, apart from the demo (${lang})`, async () => {
      const { html } = await newOrder(prefix)
      const m = main(html)
      // One panel for the fake gateway, with its tape; the demo's own words stay outside it.
      expect(count(m, /<section class="gw"/g)).toBe(1)
      expect(m).toMatch(/<section class="gw"[^>]*>\s*<p class="tape"/)
      expect(m).toContain('aria-labelledby="gw-h"')
      expect(count(m, /<h1[ >]/g)).toBe(1)
      // The amount is shown as figures in its own element.
      expect(m).toMatch(/<p class="amount"[^>]*>[\s\S]*4\.20/)
    })

    it(`shows where the visitor is in the flow (${lang})`, async () => {
      const { html } = await newOrder(prefix)
      const flow = /<ol class="flow"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? ''
      expect(count(flow, /<li/g)).toBe(3)
      expect(count(flow, /aria-current="step"/g)).toBe(1)
      expect(flow.indexOf('aria-current="step"')).toBeGreaterThan(flow.indexOf('</li>'))
      expect(flow).toContain(LANGS[lang].flow.gateway)
    })

    it(`offers the four scenarios as buttons, each with a drawn icon (${lang})`, async () => {
      const { html } = await newOrder(prefix)
      const buttons = [
        ...html.matchAll(/<button class="choice (\w+)" name="action" value="(\w+)">([\s\S]*?)<\/button>/g),
      ]
      expect(buttons.map((b) => b[1])).toEqual(['pay', 'decline', 'forge', 'swap'])
      for (const b of buttons) {
        expect(b[2], b[1]).toBe(b[1])
        expect(b[3], b[1]).toMatch(/<svg[^>]*aria-hidden="true"/)
      }
    })
  }
})

describe('order page', () => {
  for (const [lang, prefix] of LANG_CASES) {
    it(`every check carries a drawn mark and its state in words, not colour alone (${lang})`, async () => {
      for (const action of ['pay', 'decline', 'forge', 'swap']) {
        const html = await scenario(prefix, action)
        const steps = [...html.matchAll(/<li class="step (ok|fail|skip)">([\s\S]*?)<\/li>/g)]
        expect(steps.length, action).toBe(4)
        for (const [, state, body] of steps) {
          expect(body, `${action} ${state}`).toMatch(/<span class="mark[^"]*"[^>]*><svg/)
          expect(body, `${action} ${state}`).toContain(
            `<span class="state">${LANGS[lang].order.stepState[state]}</span>`,
          )
        }
        const flow = /<ol class="flow"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? ''
        expect(count(flow, /aria-current="step"/g), action).toBe(1)
        expect(flow.lastIndexOf('<li'), action).toBeLessThan(flow.indexOf('aria-current="step"'))
        expect(count(main(html), /<h1[ >]/g), action).toBe(1)
      }
    })

    it(`the verdict reason sits in a callout that names its outcome (${lang})`, async () => {
      expect(await scenario(prefix, 'pay')).toMatch(/<p class="reason ok"/)
      expect(await scenario(prefix, 'forge')).toMatch(/<p class="reason bad"/)
    })
  }

  it('a check that did not run stays on the page (the skip-link rule must not catch class="step skip")', () => {
    expect(css).not.toMatch(/(^|[\s,}])\.skip(?![-\w])[^{]*\{[^}]*position\s*:\s*absolute/)
  })

  it('draws marks with SVG, not text glyphs, and capitalises labels in CSS rather than in the text', () => {
    expect(css).not.toMatch(/content:\s*"[✓✕✔✗×]"/)
    for (const lang of Object.values(LANGS)) {
      for (const key of ['paid', 'notPaid']) {
        const text = lang.order[key]
        expect(text, key).not.toBe(text.toUpperCase())
      }
      expect(lang.pay.banner).not.toMatch(/\b[A-Z]{4,}\b/)
      expect(lang.simulatedNote).not.toMatch(/\b[A-Z]{4,}\b/)
    }
    expect(css).toMatch(/\.status[^{]*\{[^}]*text-transform:\s*uppercase/)
  })
})

describe('error pages', () => {
  for (const [lang, prefix] of LANG_CASES) {
    it(`404s are branded pages with a way back (${lang})`, async () => {
      for (const path of [`${prefix}/no-such-page`, `${prefix}/order/NOPE`, `${prefix}/pay/NOPE`]) {
        const res = await get(path)
        expect(res.status, path).toBe(404)
        const m = main(await res.text())
        expect(m, path).toMatch(/<section class="oops"/)
        expect(m, path).toMatch(/<p class="code"[^>]*>404<\/p>/)
        expect(count(m, /<h1[ >]/g), path).toBe(1)
        expect(m, path).toContain(`<a class="button" href="${prefix}/">`)
      }
    })
  }

  it('a full demo answers a branded 503 with Retry-After', async () => {
    const net = await import('node:net')
    const small = await startDemo({ perGeneration: 1 })
    const listen = net.Server.prototype.listen
    net.Server.prototype.listen = () => {
      throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
    }
    const quiet = console.error
    console.error = () => {}
    try {
      let res
      for (let i = 0; i < 4; i++) {
        res = await small.handle(
          new Request(`${base}/en/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'gateway=toyyibpay&amount=1.00',
          }),
        )
        await small.settled()
      }
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBeTruthy()
      const m = main(await res.text())
      expect(m).toMatch(/<p class="code"[^>]*>503<\/p>/)
      expect(m).toContain('<a class="button" href="/en/">')
    } finally {
      net.Server.prototype.listen = listen
      console.error = quiet
      await small.close()
    }
  })
})
