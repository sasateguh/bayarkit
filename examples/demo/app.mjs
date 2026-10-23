/**
 * bayarkit demo: every adapter against its fake gateway, in BM (`/`) and EN (`/en`), with no JavaScript in the browser.
 *
 * A visitor creates an order, lands on a SIMULATED payment page, and chooses what happens (pay / a signed callback for
 * an unpaid payment / a forged callback). The demo then delivers the gateway's callback to its own callback route,
 * which runs `confirmPayment` exactly as a shop would, and the order page shows each check.
 *
 * Gateways come from gateways/registry.json (every entry with an adapter); each one is built by the same setup file the
 * packed-tarball smoke test uses (scripts/smoke/<id>.mjs), so the demo cannot drift from what the gate checks.
 * All text lives in i18n/<lang>.json. Orders are kept in memory, capped, and vanish on restart.
 */
import { readFileSync } from 'node:fs'
import {
  checkoutResponse,
  confirmPayment,
  GatewayError,
  readCallback,
  toRinggit,
  toSen,
} from '@bayarkit/core'
import * as testing from '@bayarkit/testing'

const here = new URL('./', import.meta.url)
const root = new URL('../../', import.meta.url)
const LANGS = {
  ms: JSON.parse(readFileSync(new URL('i18n/ms.json', here), 'utf8')),
  en: JSON.parse(readFileSync(new URL('i18n/en.json', here), 'utf8')),
}
const CSS = readFileSync(new URL('demo.css', here), 'utf8')
const MAX_ORDERS = 500
// Not called: the demo delivers callbacks itself. Gateways still validate them, so they must look real.
const ORIGIN = 'https://demo.bayarkit.invalid'
const CUSTOMER = { name: 'Pelanggan Demo', email: 'demo@example.com', phone: '0123456789' }

/** Display name without the parenthesised company ("iPay88 (NTT DATA …)" → "iPay88"); the registry keeps the full one. */
const shortName = (g, lang) => String(g.label[lang] ?? g.label.en).replace(/\s*\(.*\)\s*$/, '')

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/** `t('order.heading', { reference })` → the string with `{reference}` filled in, HTML-escaped. */
function translator(lang) {
  return (path, vars = {}) => {
    const value = path.split('.').reduce((o, k) => o?.[k], LANGS[lang])
    if (typeof value !== 'string') throw new Error(`missing ${lang} text: ${path}`)
    return esc(value).replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''))
  }
}

/** Start every fake + adapter listed in the registry. */
export async function startDemo() {
  const registry = JSON.parse(readFileSync(new URL('gateways/registry.json', root), 'utf8'))
  const gateways = new Map()
  for (const entry of registry.gateways) {
    if (!entry.adapter) continue
    const { default: setup } = await import(new URL(`scripts/smoke/${entry.id}.mjs`, root).href)
    const { fake, gateway } = await setup(testing)
    gateways.set(entry.id, {
      id: entry.id,
      label: entry.adapter.label,
      evidence: entry.adapter.evidence,
      fake,
      gateway,
    })
  }
  const orders = new Map()
  let n = 0

  function page(lang, title, body, status = 200) {
    const t = translator(lang)
    const prefix = lang === 'en' ? '/en' : ''
    const other = LANGS[lang].otherLang
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · ${t('title')}</title><link rel="stylesheet" href="/demo.css"></head><body>
<header class="top"><a class="brand" href="${prefix}/">bayarkit</a><a class="lang" href="${other.prefix}/" hreflang="${lang === 'en' ? 'ms' : 'en'}">${esc(other.label)}</a></header>
<main>${body}</main><footer class="foot">${t('footer')}</footer></body></html>`
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'content-security-policy':
          "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      },
    })
  }

  function home(lang, error = '', values = {}) {
    const t = translator(lang)
    const prefix = lang === 'en' ? '/en' : ''
    const options = [...gateways.values()]
      .map(
        (g) =>
          `<option value="${g.id}"${values.gateway === g.id ? ' selected' : ''}>${esc(shortName(g, lang))} · ${t(g.evidence === 'measured' ? 'form.measured' : 'form.docs')}</option>`,
      )
      .join('')
    return page(
      lang,
      t('form.heading'),
      `<section class="intro"><h1>${t('title')}</h1><p class="lead">${t('tagline')}</p>
<p class="note">${t('simulatedNote')}</p></section>
<form class="card" method="post" action="${prefix}/checkout">
<h2>${t('form.heading')}</h2>${error ? `<p class="error" role="alert">${error}</p>` : ''}
<label for="gateway">${t('form.gateway')}</label><select id="gateway" name="gateway">${options}</select>
<label for="amount">${t('form.amount')}</label><input id="amount" name="amount" inputmode="decimal" autocomplete="off" value="${esc(values.amount ?? '1.00')}" required>
<button type="submit">${t('form.submit')}</button></form>`,
      error ? 400 : 200,
    )
  }

  async function checkout(lang, request) {
    const t = translator(lang)
    const form = await request.formData().catch(() => null)
    const values = { gateway: String(form?.get('gateway') ?? ''), amount: String(form?.get('amount') ?? '') }
    const g = gateways.get(values.gateway)
    if (!g) return home(lang, t('errors.gateway'), values)
    const amount = /^\s*\d{1,7}(\.\d{1,2})?\s*$/.test(values.amount) ? toSen(values.amount) : Number.NaN
    if (!Number.isInteger(amount)) return home(lang, t('errors.amount'), values)
    const min = g.gateway.info.minimumAmount
    if (amount < min) return home(lang, t('errors.minimum', { min: toRinggit(min) }), values)
    n += 1
    const reference = `DEMO${Date.now().toString(36).toUpperCase()}${n}`
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
      return home(lang, t('errors.refused', { message }), values)
    }
    orders.set(reference, { reference, amount, gateway: g, payment, result: null })
    // Oldest first out, so a public demo cannot grow without bound.
    while (orders.size > MAX_ORDERS) orders.delete(orders.keys().next().value)
    return Response.redirect(new URL(`${lang === 'en' ? '/en' : ''}/pay/${reference}`, request.url), 303)
  }

  function payPage(lang, order) {
    const t = translator(lang)
    const prefix = lang === 'en' ? '/en' : ''
    const label = shortName(order.gateway, lang)
    // What a real checkout route would return for this payment: shows whether the gateway takes a redirect or a form.
    const method =
      checkoutResponse(order.payment).status === 303 ? t('pay.methodRedirect') : t('pay.methodForm')
    const action = (name) =>
      `<button class="choice ${name}" name="action" value="${name}"><strong>${t(`pay.actions.${name}.label`)}</strong><span>${t(`pay.actions.${name}.hint`)}</span></button>`
    return page(
      lang,
      t('pay.heading', { amount: `RM${toRinggit(order.amount)}` }),
      `<p class="banner">${t('pay.banner', { gateway: label })}</p>
<section class="card"><h1>${t('pay.heading', { amount: `RM${toRinggit(order.amount)}` })}</h1>
<dl class="facts"><dt>${t('pay.reference')}</dt><dd><code>${esc(order.reference)}</code></dd>
<dt>${t('pay.paymentId')}</dt><dd><code>${esc(order.payment.id)}</code></dd>
<dt>${t('pay.method')}</dt><dd>${method}</dd></dl>
<form method="post" action="${prefix}/pay/${esc(order.reference)}"><p class="choose">${t('pay.choose')}</p>
<div class="choices">${action('pay')}${action('decline')}${action('forge')}</div></form></section>`,
    )
  }

  /** The simulated gateway acts, then delivers its callback to our own callback route over a real Request. */
  async function pay(lang, order, request) {
    const form = await request.formData().catch(() => null)
    const choice = String(form?.get('action') ?? '')
    if (!['pay', 'decline', 'forge'].includes(choice)) return payPage(lang, order)
    const { fake } = order.gateway
    if (choice !== 'decline') fake.markPaid(order.payment.id)
    let cb = fake.callbackFor(order.payment.id)
    if (choice === 'forge') cb = fake.tamper(cb)
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
    return Response.redirect(
      new URL(`${lang === 'en' ? '/en' : ''}/order/${order.reference}`, request.url),
      303,
    )
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

  function orderPage(lang, order) {
    const t = translator(lang)
    const prefix = lang === 'en' ? '/en' : ''
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
    const steps = Object.entries(state)
      .map(
        ([step, s]) =>
          `<li class="step ${s}"><span class="mark" aria-hidden="true"></span><span>${t(`order.steps.${step}`)}${
            step === 'query' && r?.payment
              ? `<small>${t('order.gatewaySays', { status: translator(lang)(`order.status.${r.payment.status}`) })}</small>`
              : ''
          }</span><span class="state">${t(`order.stepState.${s}`)}</span></li>`,
      )
      .join('')
    return page(
      lang,
      t('order.heading', { reference: order.reference }),
      `<section class="card"><p class="status ${status}">${t(status === 'waiting' ? 'order.waiting' : `order.${status}`)}</p>
<h1>${t('order.heading', { reference: order.reference })}</h1>
<p class="sub">${esc(shortName(order.gateway, lang))} · RM${toRinggit(order.amount)}</p>
<ol class="steps">${steps}</ol>${reason ? `<p class="reason">${t(`order.reasons.${reason}`)}</p>` : ''}
${r && !r.ok ? `<details><summary>${t('order.detail')}</summary><p><code>${esc(r.detail)}</code></p></details>` : ''}
<p class="actions"><a class="button" href="${prefix}/">${t('order.again')}</a>
<a href="https://github.com/aimanmalib/bayarkit/blob/main/packages/core/src/confirm.ts">${t('order.code')}</a></p></section>`,
    )
  }

  async function handle(request) {
    const url = new URL(request.url)
    const lang = url.pathname === '/en' || url.pathname.startsWith('/en/') ? 'en' : 'ms'
    const path = lang === 'en' ? url.pathname.slice(3) || '/' : url.pathname
    const t = translator(lang)
    if (request.method === 'GET' && url.pathname === '/demo.css')
      return new Response(CSS, {
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
      })
    if (request.method === 'GET' && path === '/') return home(lang)
    if (request.method === 'POST' && path === '/checkout') return checkout(lang, request)
    const m = /^\/(pay|order|callback)\/([A-Za-z0-9]{1,40})$/.exec(path)
    const order = m ? orders.get(m[2]) : undefined
    if (m && !order)
      return page(lang, t('errors.order'), `<p class="card error">${t('errors.order')}</p>`, 404)
    if (m?.[1] === 'pay' && request.method === 'GET') return payPage(lang, order)
    if (m?.[1] === 'pay' && request.method === 'POST') return pay(lang, order, request)
    if (m?.[1] === 'order' && request.method === 'GET') return orderPage(lang, order)
    if (m?.[1] === 'callback' && request.method === 'POST') return callback(order, request)
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }

  return {
    handle,
    gateways,
    async close() {
      for (const g of gateways.values()) await g.fake.close()
    },
  }
}
