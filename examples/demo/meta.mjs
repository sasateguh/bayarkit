/**
 * The demo's public meta: tab icons and link-preview cards (made by scripts/demo-assets.py into assets/), the routes
 * that serve them, and the <head> tags that point at them. Every value comes from site.json (origin, card type, file
 * names, card size) and i18n (title, tagline, og.alt); this module checks them once at start and holds none itself.
 *
 * og:image must be absolute (previewers do not resolve relative URLs), so the origin is required: site.json's, or
 * DEMO_PUBLIC_ORIGIN for someone hosting the demo elsewhere. Anything but a bare https origin stops the demo at start
 * rather than ever printing a relative or http og:image.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { esc } from './shell.mjs'

const here = new URL('./', import.meta.url)
const assetDir = new URL('assets/', here)
const SITE = JSON.parse(readFileSync(new URL('site.json', here), 'utf8'))
const LANGS = ['ms', 'en']
const CARD_TYPES = ['summary', 'summary_large_image']
const TYPES = { svg: 'image/svg+xml', ico: 'image/x-icon', png: 'image/png' }
// A plain file name in assets/: never a folder, never a path to join.
const FILE = /^[a-z0-9-]+\.(svg|ico|png)$/

/** `https://host[:port]` exactly, or throw. No path (not even `/`), query, fragment or credentials. */
function checkOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`demo site: origin ${JSON.stringify(value)} is not an absolute URL`)
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error(
      `demo site: origin ${JSON.stringify(value)} must be a bare https origin, like https://demo.example`,
    )
  return value
}

function file(name, what) {
  if (typeof name !== 'string' || !FILE.test(name))
    throw new Error(`demo site: ${what} must be a plain file name in assets/, got ${JSON.stringify(name)}`)
  const body = readFileSync(new URL(name, assetDir))
  return {
    name,
    path: `/${name}`,
    body,
    type: TYPES[name.split('.').pop()],
    version: createHash('sha256').update(body).digest('hex').slice(0, 10),
  }
}

/**
 * site.json (or `site`, for tests) checked, with every asset read and hashed. `publicOrigin` (DEMO_PUBLIC_ORIGIN)
 * replaces the origin when non-empty. Throws on anything the head could not be built from safely.
 */
export function loadSite({ site = SITE, publicOrigin = process.env.DEMO_PUBLIC_ORIGIN } = {}) {
  const origin = checkOrigin(publicOrigin || site.origin)
  if (!CARD_TYPES.includes(site.twitterCard))
    throw new Error(
      `demo site: twitterCard must be one of ${CARD_TYPES.join(', ')}, got ${JSON.stringify(site.twitterCard)}`,
    )
  if (typeof site.siteName !== 'string' || !site.siteName.trim())
    throw new Error('demo site: siteName is empty')
  const { width, height } = site.cardSize ?? {}
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error('demo site: cardSize needs whole-number width and height')
  const icons = {
    svg: file(site.icons?.svg, 'icons.svg'),
    ico: file(site.icons?.ico, 'icons.ico'),
    touch: file(site.icons?.touch, 'icons.touch'),
  }
  const cards = {}
  const locales = {}
  for (const lang of LANGS) {
    if (!site.cards?.[lang]) throw new Error(`demo site: no card for ${lang}`)
    if (typeof site.locales?.[lang] !== 'string') throw new Error(`demo site: no og:locale for ${lang}`)
    const card = file(site.cards[lang], `cards.${lang}`)
    if (card.type !== 'image/png') throw new Error(`demo site: card ${card.name} must be a PNG`)
    const [w, h] = [card.body.readUInt32BE(16), card.body.readUInt32BE(20)]
    if (w !== width || h !== height)
      throw new Error(`demo site: card ${card.name} is ${w}x${h}, cardSize says ${width}x${height}`)
    cards[lang] = card
    locales[lang] = site.locales[lang]
  }
  const assets = new Map([...Object.values(icons), ...Object.values(cards)].map((a) => [a.path, a]))
  return {
    origin,
    siteName: site.siteName,
    twitterCard: site.twitterCard,
    width,
    height,
    icons,
    cards,
    locales,
    assets,
  }
}

/** The <head> tags for one page in `lang`. `t` is the page's translator (its output is already escaped). */
export function headTags(site, lang, t) {
  const at = (a) => `${a.path}?v=${a.version}`
  const card = site.cards[lang]
  const image = esc(site.origin + at(card))
  const prop = (k, v) => `<meta property="${k}" content="${v}">`
  const name = (k, v) => `<meta name="${k}" content="${v}">`
  return [
    `<link rel="icon" href="${at(site.icons.svg)}" type="image/svg+xml">`,
    `<link rel="icon" href="${at(site.icons.ico)}" sizes="any">`,
    `<link rel="apple-touch-icon" href="${at(site.icons.touch)}">`,
    prop('og:type', 'website'),
    prop('og:site_name', esc(site.siteName)),
    prop('og:url', esc(site.origin + (lang === 'en' ? '/en' : '/'))),
    prop('og:locale', esc(site.locales[lang])),
    prop('og:image', image),
    prop('og:image:type', card.type),
    prop('og:image:width', site.width),
    prop('og:image:height', site.height),
    prop('og:image:alt', t('og.alt')),
    name('twitter:card', esc(site.twitterCard)),
    name('twitter:title', t('title')),
    name('twitter:description', t('tagline')),
    name('twitter:image', image),
  ].join('')
}
