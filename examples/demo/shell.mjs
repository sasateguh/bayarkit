/**
 * The frame around every demo page: header (brand, theme switch, language), the "Sasa Teguh can install this" seal,
 * the footer, the theme cookie and the self-hosted fonts. No JavaScript: the theme switch is a link to /theme, which
 * sets a cookie and redirects back; the server then marks <html data-theme> and the stylesheet does the rest.
 * The offer's text and contacts come from docs/support.json (tools/support.mjs); nothing here names a contact.
 */
import { readdirSync, readFileSync } from 'node:fs'

const here = new URL('./', import.meta.url)

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

// ── theme ────────────────────────────────────────────────────────────────────────────────────────────────────────
// `system` follows prefers-color-scheme; the cookie only ever holds one of the two explicit choices.
export const THEMES = ['system', 'light', 'dark']
const COOKIE = 'theme'
const ONE_YEAR = 365 * 24 * 60 * 60
// Where /theme may send a visitor back to: a path on this site, made only of the characters the demo's own routes use.
// Anything else (`//host`, `/\host`, a scheme, encoded CR/LF, spaces, an over-long value) goes to `/`.
const LOCAL_PATH = /^\/(?![/\\])[A-Za-z0-9/_.-]{0,200}$/

/** The visitor's theme from the Cookie header: `light`, `dark`, or `system` for anything missing or unrecognised. */
export function themeFrom(cookieHeader) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === COOKIE && (v === 'light' || v === 'dark')) return v
  }
  return 'system'
}

export const safeBack = (back) => (LOCAL_PATH.test(back ?? '') ? back : '/')

/** GET /theme?set=<theme>&back=<path>: a relative 303 back, with the cookie set (or cleared for `system`). */
export function themeRoute(url, { secure }) {
  const set = url.searchParams.get('set')
  const headers = new Headers({
    location: safeBack(url.searchParams.get('back')),
    'cache-control': 'no-store',
  })
  if (THEMES.includes(set)) {
    const attrs = `Path=/; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`
    headers.set(
      'set-cookie',
      set === 'system'
        ? `${COOKIE}=; ${attrs}; Max-Age=0`
        : `${COOKIE}=${set}; ${attrs}; Max-Age=${ONE_YEAR}`,
    )
  }
  return new Response(null, { status: 303, headers })
}

// ── fonts ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every .woff2 in fonts/ (OFL, licence files beside them), read once. Served only by exact name: no path is joined.
const fontDir = new URL('fonts/', here)
export const FONTS = new Map(
  readdirSync(fontDir)
    .filter((f) => /^[a-z0-9-]+\.woff2$/.test(f))
    .map((f) => [`/fonts/${f}`, readFileSync(new URL(f, fontDir))]),
)

// ── icons (authored SVG, one 1.75 stroke, currentColor) ─────────────────────────────────────────────────────────
const svg = (body, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
export const ICONS = {
  // Brand: a receipt slip with a tick, the one thing bayarkit decides.
  mark: `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><path class="mark-slip" d="M6 3.5h16v21l-2.67-1.6-2.66 1.6L14 22.9l-2.67 1.6-2.66-1.6L6 24.5z"/><path class="mark-tick" d="M10.2 13.6l2.6 2.6 5-5.4" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  system: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/>', 18),
  light: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    18,
  ),
  dark: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>', 18),
  // The seal: a round stamp with a spanner, "we install it".
  stamp: svg(
    '<circle cx="12" cy="12" r="9.25" stroke-dasharray="2.2 2.2"/><path d="M14.6 7.6a3 3 0 0 0-3.9 3.9l-3.3 3.3a1.2 1.2 0 0 0 1.7 1.7l3.3-3.3a3 3 0 0 0 3.9-3.9l-1.8 1.8-1.6-.1-.1-1.6z"/>',
    22,
  ),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 20),
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The links of the offer (page, email, WhatsApp), each with rel="noopener" so the page it opens cannot reach back. */
const contactList = (offer, cls) =>
  `<ul class="${cls}">${offer.links
    .map((l) => `<li><a href="${esc(l.href)}" rel="noopener" data-kind="${l.kind}">${esc(l.text)}</a></li>`)
    .join('')}</ul>`

/**
 * One whole HTML document. `t` translates (already escaped), `here` is the path the theme switch returns to,
 * `offer` is supportFor(config, lang) or null when the offer is switched off.
 */
export function shell({ lang, t, other, theme, here: path, offer, title, body, kind }) {
  const prefix = lang === 'en' ? '/en' : ''
  const back = encodeURIComponent(safeBack(path))
  const themeLinks = THEMES.map(
    (name) =>
      `<a class="opt" href="/theme?set=${name}&amp;back=${back}"${theme === name ? ' aria-current="true"' : ''} title="${t(`theme.${name}`)}">${ICONS[name]}<span class="vh">${t(`theme.${name}`)}</span></a>`,
  ).join('')
  const seal = offer
    ? `<aside class="seal" aria-label="${esc(offer.cta)}"><div class="seal-in"><span class="seal-mark">${ICONS.stamp}</span><div class="seal-text"><p>${esc(offer.seal)}</p>${contactList(offer, 'seal-links')}</div></div></aside>`
    : ''
  const help = offer
    ? `<section class="help" aria-labelledby="help-h"><h2 id="help-h">${esc(offer.heading)}</h2><p>${esc(offer.body)}</p>${contactList(offer, 'help-links')}</section>`
    : ''
  const fonts = [...FONTS.keys()]
    .map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`)
    .join('')
  return `<!doctype html><html lang="${lang}" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${title} · ${t('title')}</title><meta name="description" content="${t('tagline')}">
<meta property="og:title" content="${t('title')}"><meta property="og:description" content="${t('tagline')}">${fonts}<link rel="stylesheet" href="/demo.css"></head>
<body class="page-${kind}"><a class="skip" href="#main">${t('skip')}</a>
<header class="top"><div class="bar"><a class="brand" href="${prefix}/">${ICONS.mark}<span class="word">bayarkit</span><span class="tag">demo</span></a>
<nav class="prefs" aria-label="${t('theme.label')}"><span class="theme">${themeLinks}</span>
<a class="lang" href="${other.prefix}/" hreflang="${lang === 'en' ? 'ms' : 'en'}" lang="${lang === 'en' ? 'ms' : 'en'}" title="${esc(other.label)}"><span aria-hidden="true">${esc(other.short)}</span><span class="vh">${esc(other.label)}</span></a></nav></div></header>
${seal}
<main id="main" class="wrap">${body}</main>
<footer class="foot"><div class="wrap foot-in">${help}<div class="about"><p>${t('footer')}</p><p class="links"><a href="https://github.com/sasateguh/bayarkit">GitHub</a>
<a href="${t('links.caseStudyUrl')}">${t('links.caseStudy')}</a><a href="https://www.npmjs.com/package/@bayarkit/core">npm</a></p></div></div></footer></body></html>`
}
