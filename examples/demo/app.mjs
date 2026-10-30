/**
 * bayarkit demo: every adapter against its fake gateway, in BM (`/`) and EN (`/en`), with no JavaScript in the browser.
 *
 * A visitor creates an order, lands on a SIMULATED payment page, and chooses what happens (pay / a signed callback for
 * an unpaid payment / a forged callback). The demo then delivers the gateway's callback to its own callback route,
 * which runs `confirmPayment` exactly as a shop would, and the order page shows each check.
 *
 * Gateways come from gateways/registry.json (every entry with an adapter); each one is built by the same setup file the
 * packed-tarball smoke test uses (scripts/smoke/<id>.mjs), so the demo cannot drift from what the gate checks.
 * All text lives in i18n/<lang>.json; the "need help installing?" offer in docs/support.json; the page frame (header,
 * theme switch, offer seal, footer, fonts) in shell.mjs. Orders are kept in memory, capped, and vanish on restart.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  checkoutResponse,
  confirmPayment,
  GatewayError,
  readCallback,
  toRinggit,
  toSen,
} from '@bayarkit/core'
import * as testing from '@bayarkit/testing'
import { loadSupport, supportFor } from '../../tools/support.mjs'
import { esc, FONTS, shell, themeFrom, themeRoute } from './shell.mjs'
import { errorView, homeView, orderView, payView } from './views.mjs'

const here = new URL('./', import.meta.url)
const root = new URL('../../', import.meta.url)
const LANGS = {
  ms: JSON.parse(readFileSync(new URL('i18n/ms.json', here), 'utf8')),
  en: JSON.parse(readFileSync(new URL('i18n/en.json', here), 'utf8')),
}
// One stylesheet for the browser, kept in two files: the frame + home page, then the pages after it.
const CSS = ['demo.css', 'pages.css'].map((f) => readFileSync(new URL(f, here), 'utf8')).join('\n')
// Memory stays bounded when hosted: every PER_GENERATION checkouts a fresh set of fakes starts, and the set before the
// previous one is closed with its orders (the fakes keep every bill they ever saw).
const PER_GENERATION = 250
// Not called: the demo delivers callbacks itself. Gateways still validate them, so they must look real.
const ORIGIN = 'https://demo.bayarkit.invalid'
const CUSTOMER = { name: 'Pelanggan Demo', email: 'demo@example.com', phone: '0123456789' }
// The scenarios on the simulated payment page, in the order shown.
const CHOICES = ['pay', 'decline', 'forge', 'swap']
// Served with every response. `no-transform`: behind Cloudflare, without it CF injects its analytics beacon into HTML.
const NO_CACHE = 'no-store, no-transform'
// Fonts never change under the same name (a new font = a new file name), so browsers may keep them for a week.
const FONT_CACHE = 'public, max-age=604800, no-transform'
// Sent with every page and the stylesheet. Nothing is embedded, framed or loaded from elsewhere, so all of it is the strictest value.
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'x-permitted-cross-domain-policies': 'none',
}

/** Display name without the parenthesised company ("iPay88 (NTT DATA …)" → "iPay88"); the registry keeps the full one. */
const shortName = (g, lang) => String(g.label[lang] ?? g.label.en).replace(/\s*\(.*\)\s*$/, '')

/** `t('order.heading', { reference })` → the string with `{reference}` filled in, HTML-escaped. */
function translator(lang) {
  return (path, vars = {}) => {
    const value = path.split('.').reduce((o, k) => o?.[k], LANGS[lang])
    if (typeof value !== 'string') throw new Error(`missing ${lang} text: ${path}`)
    return esc(value).replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''))
  }
}

/**
 * `fetch` over one http.Agent, for one set of fakes. Global fetch keeps a connection pool for every origin it has seen
 * and never drops it; each set of fakes listens on new ports, so a long-running demo grew by ~1.7 MB per 1 000
 * checkouts (heap measured after GC, 28 Oct 2026). Destroying the agent with its set frees everything.
 */
function agentFetch(agent) {
  return async (input, init) => {
    const req = new Request(input, init) // normalises every body type and its content-type
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined
    const url = new URL(req.url)
    return new Promise((resolve, reject) => {
      const out = httpRequest(
        url,
        { method: req.method, headers: Object.fromEntries(req.headers), agent, signal: req.signal },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('error', reject)
          res.on('end', () => {
            const headers = new Headers()
            for (const [k, v] of Object.entries(res.headers)) {
              for (const one of [v].flat()) if (one !== undefined) headers.append(k, one)
            }
            const status = res.statusCode ?? 502
            const nullBody = status === 204 || status === 304 || req.method === 'HEAD'
            resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers }))
          })
        },
      )
      out.on('error', reject)
      out.end(body)
    })
  }
}

/**
 * Start every fake + adapter listed in the registry. `support` replaces docs/support.json (tests); a config that
 * fails its checks stops the demo before any fake starts. `cookieSecure` adds Secure to the theme cookie (HTTPS hosts).
 */
export async function startDemo({
  perGeneration = PER_GENERATION,
  support,
  cookieSecure = process.env.COOKIE_SECURE === '1',
} = {}) {
  const offerConfig = loadSupport(fileURLToPath(root), support)
  const registry = JSON.parse(readFileSync(new URL('gateways/registry.json', root), 'utf8'))
  async function startGeneration() {
    const set = new Map()
    const agent = new Agent({ keepAlive: true })
    const fetch = agentFetch(agent)
    try {
      for (const entry of registry.gateways) {
        if (!entry.adapter) continue
        const { default: setup } = await import(new URL(`scripts/smoke/${entry.id}.mjs`, root).href)
        const { fake, gateway } = await setup(testing, { fetch })
        set.set(entry.id, {
          id: entry.id,
          label: entry.adapter.label,
          evidence: entry.adapter.evidence,
          fake,
          gateway,
          agent,
        })
      }
    } catch (e) {
      // Half-started: close what did start, so a failed rotation leaks no servers.
      agent.destroy()
      for (const g of set.values()) await g.fake.close().catch(() => {})
      throw e
    }
    return set
  }
  /** Connections first (an open keep-alive socket would hold a fake's close), then the fakes. */
  async function closeSet(set) {
    for (const g of set.values()) g.agent.destroy()
    for (const g of set.values()) await g.fake.close()
  }
  let gateways = await startGeneration()
  const generations = [gateways]
  const orders = new Map()
  // Orders started per fake set: rotation is decided on this count, re-checked on every checkout, so a rotation that
  // is still running never makes the next ones skip (a modulo check did, and memory grew under load).
  const started = new Map()
  let rotating = null

  // After a failed rotation, no new attempt for a while: retrying on every request would start 14 servers each time.
  const RETRY_AFTER_MS = 30_000
  let failedAt = 0
  const coolingDown = () => Date.now() - failedAt < RETRY_AFTER_MS

  function startRotation() {
    // A failed rotation keeps the current set and is logged; it must never take the server down.
    rotating = rotate()
      .catch((e) => {
        failedAt = Date.now()
        console.error('demo: rotation failed:', e instanceof Error ? e.message : e)
      })
      .finally(() => {
        rotating = null
      })
  }

  async function rotate() {
    const next = await startGeneration()
    generations.push(next)
    gateways = next
    while (generations.length > 2) {
      const old = generations.shift()
      for (const [ref, order] of orders) if (order.generation === old) orders.delete(ref)
      started.delete(old)
      await closeSet(old)
    }
  }

  /** A relative 303: the Host header never decides where a visitor is sent. */
  const seeOther = (path) => new Response(null, { status: 303, headers: { location: path } })

  /**
   * A whole page in the shell. `ctx` is the request's language, translator, theme and path (see `handle`); `kind`
   * names the page for the stylesheet (home, pay, order, error).
   */
  function page(ctx, title, body, status = 200, kind = 'error') {
    const { lang } = ctx
    const html = shell({
      ...ctx,
      other: LANGS[lang].otherLang,
      offer: supportFor(offerConfig, lang),
      title,
      body,
      kind,
    })
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': NO_CACHE,
        'x-robots-tag': 'noindex',
        'content-security-policy':
          "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ...SECURITY,
      },
    })
  }

  function home(ctx, error = '', values = {}) {
    const { lang, t } = ctx
    const options = [...gateways.values()].map((g) => ({
      id: g.id,
      name: shortName(g, lang),
      measured: g.evidence === 'measured',
      selected: values.gateway === g.id,
    }))
    // The four checks, in the order confirmPayment runs them; the same step names the order page uses.
    const checks = ['received', 'signature', 'query', 'match']
    const body = homeView(t, { lang, options, checks, error, amount: values.amount ?? '1.00' })
    return page(ctx, t('form.heading'), body, error ? 400 : 200, 'home')
  }

  /** A branded 404 / 503 page: `kind` names the message in errors.<kind>. */
  const failure = (ctx, code, kind) =>
    page(ctx, ctx.t(`errors.headings.${kind}`), errorView(ctx.t, { lang: ctx.lang, code, kind }), code)

  /** 503 while the demo cannot make room (rotation failing): refusing keeps memory bounded. */
  function busy(ctx) {
    const response = failure(ctx, 503, 'busy')
    response.headers.set('retry-after', String(RETRY_AFTER_MS / 1000))
    return response
  }

  async function checkout(ctx, request) {
    const { lang, t } = ctx
    const form = await request.formData().catch(() => null)
    const values = { gateway: String(form?.get('gateway') ?? ''), amount: String(form?.get('amount') ?? '') }
    // Rotation is decided BEFORE a set is taken, in synchronous code, so parallel checkouts see each other: a full set
    // starts a rotation, and past twice its share a checkout waits for the new set (back-pressure). No set ever holds
    // more than 2 × perGeneration, whatever the timing (tested with 100 parallel checkouts).
    for (;;) {
      const count = started.get(gateways) ?? 0
      if (count >= perGeneration && !rotating && !coolingDown()) startRotation()
      if (count >= 2 * perGeneration && !rotating && coolingDown()) return busy(ctx)
      if (!rotating || count < 2 * perGeneration) break
      await rotating
    }
    // Take the set ONCE: a rotation can finish while createPayment is awaited, and the order must stay with the set its
    // gateway came from (otherwise it outlives that set's closed fakes).
    const generation = gateways
    const g = generation.get(values.gateway)
    // Counted now, not after createPayment: parallel checkouts must see each other in the check above.
    if (g) started.set(generation, (started.get(generation) ?? 0) + 1)
    if (!g) return home(ctx, t('errors.gateway'), values)
    const amount = /^\s*\d{1,7}(\.\d{1,2})?\s*$/.test(values.amount) ? toSen(values.amount) : Number.NaN
    if (!Number.isInteger(amount)) return home(ctx, t('errors.amount'), values)
    const min = g.gateway.info.minimumAmount
    if (amount < min) return home(ctx, t('errors.minimum', { min: toRinggit(min) }), values)
    // Unguessable, and within the shortest reference limit of any adapter (eGHL: 20 characters).
    const reference = `DEMO${randomBytes(8).toString('hex').toUpperCase()}`
    let payment
    try {
      payment = await g.gateway.createPayment({
        reference,
        amount,
        description: `Demo ${reference}`,
        customer: CUSTOMER,
        returnUrl: `${ORIGIN}/order/${reference}`,
        callbackUrl: `${ORIGIN}/callback/${reference}`,
      })
    } catch (e) {
      const message = e instanceof GatewayError ? e.message : 'error'
      return home(ctx, t('errors.refused', { message }), values)
    }
    orders.set(reference, {
      reference,
      amount,
      gateway: g,
      generation,
      payment,
      choice: null,
      result: null,
    })
    return seeOther(`${lang === 'en' ? '/en' : ''}/pay/${reference}`)
  }

  function payPage(ctx, order) {
    const { lang, t } = ctx
    // What a real checkout route would return for this payment: shows whether the gateway takes a redirect or a form.
    const method =
      checkoutResponse(order.payment).status === 303 ? t('pay.methodRedirect') : t('pay.methodForm')
    const body = payView(t, {
      lang,
      gateway: shortName(order.gateway, lang),
      amount: toRinggit(order.amount),
      reference: order.reference,
      paymentId: order.payment.id,
      method,
      choices: CHOICES,
    })
    return page(ctx, t('pay.heading', { amount: `RM${toRinggit(order.amount)}` }), body, 200, 'pay')
  }

  /** The simulated gateway acts, then delivers its callback to our own callback route over a real Request. */
  async function pay(ctx, order, request) {
    const { lang } = ctx
    const form = await request.formData().catch(() => null)
    const choice = String(form?.get('action') ?? '')
    const orderPath = `${lang === 'en' ? '/en' : ''}/order/${order.reference}`
    // One choice per order: "forge" marks the fake paid, so a later "decline" would (correctly) confirm as paid and
    // show a scenario the visitor did not pick. Another scenario = another order.
    if (order.choice) return seeOther(orderPath)
    if (!CHOICES.includes(choice)) return payPage(ctx, order)
    order.choice = choice
    const { fake, gateway } = order.gateway
    let cb
    if (choice === 'swap') {
      // Another order at the same shop, cheaper and really paid: its genuine, correctly signed callback is replayed
      // against this order. Only the third check (reference + amount) can catch it.
      const other = await gateway
        .createPayment({
          reference: `DEMO${randomBytes(8).toString('hex').toUpperCase()}`,
          amount: gateway.info.minimumAmount,
          description: 'Demo other order',
          customer: CUSTOMER,
          returnUrl: `${ORIGIN}/order/other`,
          callbackUrl: `${ORIGIN}/callback/other`,
        })
        .catch(() => null)
      if (!other) {
        order.choice = null
        return payPage(ctx, order)
      }
      started.set(order.generation, (started.get(order.generation) ?? 0) + 1)
      fake.markPaid(other.id)
      cb = fake.callbackFor(other.id)
    } else {
      if (choice !== 'decline') fake.markPaid(order.payment.id)
      cb = fake.callbackFor(order.payment.id)
      if (choice === 'forge') cb = fake.tamper(cb)
    }
    const delivery = cb.rawBody
      ? new Request(`${ORIGIN}/callback/${order.reference}`, {
          method: 'POST',
          headers: cb.headers,
          body: cb.rawBody,
        })
      : new Request(`${ORIGIN}/callback/${order.reference}`, {
          method: 'POST',
          headers: { ...cb.headers, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(cb.fields).toString(),
        })
    await handle(delivery)
    return seeOther(orderPath)
  }

  /** The shop's callback route: exactly what an app does. */
  async function callback(order, request) {
    const result = await confirmPayment(order.gateway.gateway, await readCallback(request), {
      reference: order.reference,
      amount: order.amount,
    })
    // Gateways retry callbacks: once paid, stay paid; otherwise keep the latest answer.
    if (!order.result?.ok) order.result = result
    return new Response('OK')
  }

  function orderPage(ctx, order) {
    const { lang, t } = ctx
    const r = order.result
    const status = !r ? 'waiting' : r.ok ? 'paid' : 'notPaid'
    const reason = !r ? '' : r.ok ? 'ok' : r.reason
    const state = {
      received: r ? 'ok' : 'skip',
      signature: !r ? 'skip' : reason === 'invalid_signature' ? 'fail' : 'ok',
      query:
        !r || reason === 'invalid_signature'
          ? 'skip'
          : reason === 'gateway_error'
            ? 'fail'
            : r.payment
              ? 'ok'
              : 'skip',
      match: !r ? 'skip' : r.ok ? 'ok' : reason === 'mismatch' ? 'fail' : 'skip',
    }
    const steps = Object.entries(state).map(([step, s]) => [
      step,
      s,
      step === 'query' && r?.payment
        ? t('order.gatewaySays', { status: t(`order.status.${r.payment.status}`) })
        : '',
    ])
    const body = orderView(t, {
      lang,
      reference: order.reference,
      gateway: shortName(order.gateway, lang),
      amount: toRinggit(order.amount),
      outcome: status,
      steps,
      reason,
      detail: r && !r.ok ? r.detail : '',
    })
    return page(ctx, t('order.heading', { reference: order.reference }), body, 200, 'order')
  }

  async function handle(request) {
    const url = new URL(request.url)
    const lang = url.pathname === '/en' || url.pathname.startsWith('/en/') ? 'en' : 'ms'
    const path = lang === 'en' ? url.pathname.slice(3) || '/' : url.pathname
    const t = translator(lang)
    // What every page needs to draw its frame. `here` is where the theme switch returns: the page itself for a GET,
    // the home page after a POST (a form answer cannot be fetched again).
    const ctx = {
      lang,
      t,
      theme: themeFrom(request.headers.get('cookie')),
      here: request.method === 'GET' ? url.pathname : lang === 'en' ? '/en/' : '/',
    }
    if (request.method === 'GET' && url.pathname === '/demo.css')
      return new Response(CSS, {
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': NO_CACHE, ...SECURITY },
      })
    if (request.method === 'GET' && FONTS.has(url.pathname))
      return new Response(FONTS.get(url.pathname), {
        headers: { 'content-type': 'font/woff2', 'cache-control': FONT_CACHE, ...SECURITY },
      })
    if (request.method === 'GET' && path === '/theme') return themeRoute(url, { secure: cookieSecure })
    if (request.method === 'GET' && url.pathname === '/healthz')
      return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': NO_CACHE } })
    if (request.method === 'GET' && path === '/') return home(ctx)
    if (request.method === 'POST' && path === '/checkout') return checkout(ctx, request)
    const m = /^\/(pay|order|callback)\/([A-Za-z0-9]{1,40})$/.exec(path)
    const order = m ? orders.get(m[2]) : undefined
    if (m && !order) return failure(ctx, 404, 'order')
    if (m?.[1] === 'pay' && request.method === 'GET')
      return order.choice
        ? seeOther(`${lang === 'en' ? '/en' : ''}/order/${order.reference}`)
        : payPage(ctx, order)
    if (m?.[1] === 'pay' && request.method === 'POST') return pay(ctx, order, request)
    if (m?.[1] === 'order' && request.method === 'GET') return orderPage(ctx, order)
    if (m?.[1] === 'callback' && request.method === 'POST') return callback(order, request)
    return failure(ctx, 404, 'notFound')
  }

  return {
    handle,
    /** For tests: how many orders and fake generations are held right now. */
    stats: () => ({ orders: orders.size, generations: generations.length }),
    /** Resolves when no rotation is running (tests). */
    settled: async () => {
      while (rotating) await rotating
    },
    get gateways() {
      return gateways
    },
    async close() {
      await rotating
      for (const set of generations) await closeSet(set)
    },
  }
}
