/**
 * The "need help installing?" offer — one config, docs/support.json, read by the demo and by the README generators.
 * Text and links live in the config; this module only loads it and refuses text that must never be published:
 * a contact other than the three the maintainers chose, a price, or a ranking claim. A bad config fails the gate
 * instead of reaching a README or the hosted demo. `enabled: false` removes the offer everywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SUPPORT_FILE = 'docs/support.json'
export const LANGS = ['en', 'ms']

/** The only contact channels the offer may name. A guard, not content: change it together with the policy. */
const ALLOWED = {
  page: { en: 'https://sasateguh.com/contact', ms: 'https://sasateguh.com/ms/contact' },
  email: 'admin@sasateguh.com',
  whatsapp: { display: '017-762 9379', url: 'https://wa.me/60177629379' },
}
const ALLOWED_URLS = new Set([...Object.values(ALLOWED.page), ALLOWED.whatsapp.url])
const ALLOWED_PHONES = new Set(['0177629379', '60177629379'])

const FORBIDDEN = [
  [/gmail/i, 'a Gmail address'],
  [/batu\s*kurau/i, 'a home address'],
  [/\b019[- ]?\d/, 'a 019 number'],
  [
    /\bRM ?\d|\$ ?\d|\bUSD\b|\bMYR ?\d|\bprice\b|\bharga\b|\bper (hour|month|jam|bulan)\b/i,
    'a price or rate',
  ],
  [/\b(free|percuma)\b/i, 'a free offer'],
  [
    /#1\b|\bterbaik\b|\bbest\b|nombor satu|number one|termurah|paling murah|cheapest|\bleading\b|top-rated/i,
    'a ranking claim',
  ],
]

const REQUIRED = [
  ...LANGS.map((l) => `contact.page.${l}`),
  'contact.email',
  'contact.whatsapp.display',
  'contact.whatsapp.url',
  ...LANGS.flatMap((l) => [
    `labels.${l}.page`,
    `labels.${l}.email`,
    `labels.${l}.whatsapp`,
    `demo.${l}.seal`,
    `demo.${l}.cta`,
    `readme.${l}.heading`,
    `readme.${l}.body`,
  ]),
]

const at = (obj, path) =>
  path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), obj)

function* strings(value, path = '') {
  if (typeof value === 'string') yield [path, value]
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k)
}

function textProblems(path, text) {
  const out = []
  for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [])
    if (email.toLowerCase() !== ALLOWED.email) out.push(`${path}: email ${email} is not an allowed contact`)
  for (const url of text.match(/https?:\/\/[^\s"<>)]+/g) ?? [])
    if (!ALLOWED_URLS.has(url)) out.push(`${path}: link ${url} is not an allowed contact`)
  for (const wa of text.match(/\bwa\.me\/\d+/g) ?? [])
    if (wa !== 'wa.me/60177629379') out.push(`${path}: WhatsApp ${wa} is not an allowed contact`)
  for (const phone of text.match(/(\+?60[- ]?)?0?1\d[- ]?\d{3,4}[- ]?\d{4}/g) ?? [])
    if (!ALLOWED_PHONES.has(phone.replace(/\D/g, '')))
      out.push(`${path}: number ${phone} is not an allowed contact`)
  for (const [re, what] of FORBIDDEN) if (re.test(text)) out.push(`${path}: ${what} ("${text.match(re)[0]}")`)
  return out
}

/** Every problem in a support config, as readable strings; an empty list means it may be published. */
export function validateSupport(config) {
  if (!config || typeof config !== 'object') return ['the config must be an object']
  if (typeof config.enabled !== 'boolean') return ['enabled must be true or false']
  const problems = []
  if (config.enabled) {
    for (const path of REQUIRED) {
      const v = at(config, path)
      if (typeof v !== 'string' || !v.trim()) problems.push(`${path} is missing`)
    }
    for (const path of REQUIRED.filter((p) => p.startsWith('contact.'))) {
      const v = at(config, path)
      if (typeof v === 'string' && v !== at(ALLOWED, path.slice('contact.'.length)))
        problems.push(`${path}: ${v} is not the allowed contact`)
    }
  }
  for (const [path, text] of strings(config)) problems.push(...textProblems(path, text))
  return [...new Set(problems)]
}

/** The offer in one language, or null when it is switched off. Links are always page, email, WhatsApp, in that order. */
export function supportFor(config, lang) {
  if (!config.enabled) return null
  const { contact, labels, demo, readme } = config
  const label = labels[lang]
  return {
    ...readme[lang],
    ...demo[lang],
    links: [
      { kind: 'page', label: label.page, href: contact.page[lang], text: label.page },
      { kind: 'email', label: label.email, href: `mailto:${contact.email}`, text: contact.email },
      { kind: 'whatsapp', label: label.whatsapp, href: contact.whatsapp.url, text: contact.whatsapp.display },
    ],
  }
}

/** Reads and checks docs/support.json under `root`; throws with every problem listed. `config` replaces the file in tests. */
export function loadSupport(root, config = JSON.parse(readFileSync(join(root, SUPPORT_FILE), 'utf8'))) {
  const problems = validateSupport(config)
  if (problems.length) throw new Error(`${SUPPORT_FILE} cannot be published:\n- ${problems.join('\n- ')}`)
  return config
}
