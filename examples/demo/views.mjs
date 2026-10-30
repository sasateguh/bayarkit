/**
 * The HTML inside <main> for every demo page. app.mjs decides what happened (orders, checks, errors); this file only
 * draws it. `t` translates and escapes; every other value passed in is escaped here.
 * The simulated payment page is drawn as a different object from the demo (a taped "fake gateway" panel), so nobody
 * mistakes it for a real bank page; the order page reads like the four-check ledger on the home page.
 */
import { esc, ICONS } from './shell.mjs'

// Drawn marks and scenario icons, one 1.75 stroke like the shell's icons (never text glyphs).
const svg = (body, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
const MARKS = {
  ok: svg('<path d="M6 12.5l4 4 8-9"/>', 14),
  fail: svg('<path d="M7 7l10 10M17 7L7 17"/>', 14),
  skip: svg('<path d="M7.5 12h9"/>', 14),
}
const SCENARIO = {
  pay: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.5"/>', 22),
  decline: svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 18.4L18.4 5.6"/>', 22),
  forge: svg(
    '<path d="M3 16c2.5-5 4.5-6 5.5-3.5S11 16 13 12s3.5-3.5 4.5-1"/><path d="M3 20.5h18"/><path d="M17 3l4 4M21 3l-4 4"/>',
    22,
  ),
  swap: svg('<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>', 22),
}

const prefixOf = (lang) => (lang === 'en' ? '/en' : '')

/** Where the visitor is: order → simulated gateway → result. `at` is the current step's index. */
function flow(t, at) {
  const items = ['order', 'gateway', 'result']
    .map(
      (k, i) =>
        `<li${i === at ? ' aria-current="step"' : ''}><span class="fn" aria-hidden="true">${i + 1}</span>${t(`flow.${k}`)}</li>`,
    )
    .join('')
  return `<ol class="flow" aria-label="${t('flow.label')}">${items}</ol>`
}

/** Home: the statement, the slip (pick a gateway + amount) and the four checks. */
export function homeView(t, { lang, options, checks, error, amount }) {
  const option = (g) =>
    `<option value="${esc(g.id)}"${g.selected ? ' selected' : ''}>${esc(g.name)} · ${t(g.measured ? 'form.measured' : 'form.docs')}</option>`
  const check = (step, i) =>
    `<li class="check"><span class="n" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><div><h3>${t(`order.steps.${step}`)}</h3><p>${t(`home.checks.${step}`)}</p></div></li>`
  return `<div class="home"><section class="intro"><h1>${t('home.heading')}</h1><p class="lead">${t('home.lead')}</p></section>
<form class="slip" method="post" action="${prefixOf(lang)}/checkout" aria-labelledby="slip-h">
<div class="slip-head"><h2 id="slip-h">${t('form.heading')}</h2><span class="slip-tag">${t('form.tag')}</span></div>
<div class="slip-body">${error ? `<p class="error" role="alert">${error}</p>` : ''}
<label for="gateway">${t('form.gateway')}</label><select id="gateway" name="gateway">${options.map(option).join('')}</select>
<label for="amount">${t('form.amount')}</label><div class="money"><span class="cur" aria-hidden="true">RM</span><input id="amount" name="amount" inputmode="decimal" autocomplete="off" value="${esc(amount)}" required></div>
<button type="submit">${t('form.submit')}${ICONS.arrow}</button>
<p class="note">${t('simulatedNote')}</p></div></form>
<section class="rail" aria-labelledby="rail-h"><h2 id="rail-h">${t('home.checksHeading')}</h2>
<ol class="checks">${checks.map(check).join('')}</ol><p class="verdict"><span class="stamp">${t('order.paid')}</span><span>${t('home.verdict')}</span></p></section></div>`
}

/** The simulated payment page: the fake gateway's panel, taped as a simulation, with the four scenarios. */
export function payView(t, { lang, gateway, amount, reference, paymentId, method, choices }) {
  const choice = (name) =>
    `<button class="choice ${name}" name="action" value="${name}"><span class="ci">${SCENARIO[name]}</span><span class="ct"><strong>${t(`pay.actions.${name}.label`)}</strong><span>${t(`pay.actions.${name}.hint`)}</span></span></button>`
  return `<div class="trip">${flow(t, 1)}
<section class="gw" aria-labelledby="gw-h"><p class="tape">${t('pay.banner', { gateway })}</p>
<div class="gw-in"><div class="gw-head"><p class="gw-name">${esc(gateway)}</p><h1 id="gw-h">${t('pay.title')}</h1>
<p class="amount"><span class="cur">RM</span>${esc(amount)}</p></div>
<dl class="facts"><div><dt>${t('pay.reference')}</dt><dd><code>${esc(reference)}</code></dd></div>
<div><dt>${t('pay.paymentId')}</dt><dd><code>${esc(paymentId)}</code></dd></div>
<div><dt>${t('pay.method')}</dt><dd>${method}</dd></div></dl>
<form method="post" action="${prefixOf(lang)}/pay/${esc(reference)}" aria-labelledby="choose-h"><h2 class="choose" id="choose-h">${t('pay.choose')}</h2>
<div class="choices">${choices.map(choice).join('')}</div></form></div></section></div>`
}

/**
 * The order page: the verdict, then each check with a drawn mark and its state in words. `steps` is
 * [[step, 'ok'|'fail'|'skip', note?]]; `outcome` is 'paid' | 'notPaid' | 'waiting'.
 */
export function orderView(t, { lang, reference, gateway, amount, outcome, steps, reason, detail }) {
  const items = steps
    .map(
      ([step, s, note]) =>
        `<li class="step ${s}"><span class="mark" aria-hidden="true">${MARKS[s]}</span><span class="what">${t(`order.steps.${step}`)}${note ? `<small>${note}</small>` : ''}</span><span class="state">${t(`order.stepState.${s}`)}</span></li>`,
    )
    .join('')
  const tone = outcome === 'paid' ? 'ok' : outcome === 'notPaid' ? 'bad' : 'wait'
  return `<div class="trip">${flow(t, 2)}
<article class="result ${tone}" aria-labelledby="order-h"><header class="result-head"><div>
<p class="sub">${esc(gateway)} · <span class="num">RM${esc(amount)}</span></p><h1 id="order-h">${t('order.heading', { reference })}</h1></div>
<p class="status ${outcome}">${t(outcome === 'waiting' ? 'order.waiting' : `order.${outcome}`)}</p></header>
<ol class="steps">${items}</ol>${reason ? `<p class="reason ${tone}">${t(`order.reasons.${reason}`)}</p>` : ''}
${detail ? `<details><summary>${t('order.detail')}</summary><p><code>${esc(detail)}</code></p></details>` : ''}
<p class="actions"><a class="button" href="${prefixOf(lang)}/">${t('order.again')}${ICONS.arrow}</a>
<a href="https://github.com/sasateguh/bayarkit/blob/main/packages/core/src/confirm.ts">${t('order.code')}</a></p></article></div>`
}

/** 404 / 503: the status code, what went wrong, and the way back to the demo. `kind` names errors.<kind>. */
export function errorView(t, { lang, code, kind }) {
  return `<section class="oops" aria-labelledby="oops-h"><p class="code">${code}</p><h1 id="oops-h">${t(`errors.headings.${kind}`)}</h1>
<p class="lead">${t(`errors.${kind}`)}</p><p class="actions"><a class="button" href="${prefixOf(lang)}/">${t('errors.back')}${ICONS.arrow}</a></p></section>`
}
