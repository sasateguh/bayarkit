import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadSupport, supportFor, validateSupport } from '../support.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const shipped = JSON.parse(readFileSync(`${root}docs/support.json`, 'utf8'))

// A frozen config, so these tests pin the rules rather than whatever text docs/support.json holds today.
const valid = () => ({
  enabled: true,
  contact: {
    page: { en: 'https://sasateguh.com/contact', ms: 'https://sasateguh.com/ms/contact' },
    email: 'admin@sasateguh.com',
    whatsapp: { display: '017-762 9379', url: 'https://wa.me/60177629379' },
  },
  labels: {
    en: { page: 'Contact page', email: 'Email', whatsapp: 'WhatsApp' },
    ms: { page: 'Halaman hubungi', email: 'E-mel', whatsapp: 'WhatsApp' },
  },
  demo: {
    en: { seal: 'Sasa Teguh can install this for you.', cta: 'Ask Sasa Teguh' },
    ms: { seal: 'Sasa Teguh boleh memasangnya untuk anda.', cta: 'Tanya Sasa Teguh' },
  },
  readme: {
    en: { heading: 'Need help installing?', body: 'Sasa Teguh can install it on your site.' },
    ms: { heading: 'Perlukan bantuan memasang?', body: 'Sasa Teguh boleh memasangnya di laman anda.' },
  },
})

const withText = (text) => {
  const c = valid()
  c.readme.en.body = text
  return c
}

describe('docs/support.json', () => {
  it('the shipped config passes its own rules', () => {
    expect(validateSupport(shipped)).toEqual([])
    expect(() => loadSupport(root)).not.toThrow()
  })

  it('a valid config has no problems', () => {
    expect(validateSupport(valid())).toEqual([])
  })

  it('gives each language its text and exactly the three contact links', () => {
    for (const lang of ['en', 'ms']) {
      const s = supportFor(valid(), lang)
      expect(s.heading).toBe(valid().readme[lang].heading)
      expect(s.seal).toBe(valid().demo[lang].seal)
      expect(s.links.map((l) => l.href)).toEqual([
        valid().contact.page[lang],
        'mailto:admin@sasateguh.com',
        'https://wa.me/60177629379',
      ])
      expect(s.links.map((l) => l.label)).toEqual(Object.values(valid().labels[lang]))
    }
  })

  it('enabled: false means no offer anywhere', () => {
    const c = valid()
    c.enabled = false
    expect(validateSupport(c)).toEqual([])
    expect(supportFor(c, 'en')).toBeNull()
    expect(supportFor(c, 'ms')).toBeNull()
    expect(validateSupport({ enabled: false })).toEqual([])
  })

  it('rejects a config missing a language or a contact', () => {
    const c = valid()
    delete c.readme.ms
    delete c.contact.whatsapp
    const problems = validateSupport(c).join('\n')
    expect(problems).toMatch(/readme\.ms/)
    expect(problems).toMatch(/contact\.whatsapp/)
    expect(validateSupport({})).not.toEqual([])
    expect(validateSupport({ enabled: 'yes' })).not.toEqual([])
  })

  it.each([
    ['another email address', (c) => (c.contact.email = 'hello@sasateguh.com')],
    ['a Gmail address', (c) => (c.contact.email = 'sasateguh@gmail.com')],
    ['another WhatsApp link', (c) => (c.contact.whatsapp.url = 'https://wa.me/60191234567')],
    ['another WhatsApp number shown', (c) => (c.contact.whatsapp.display = '019-123 4567')],
    ['another contact page', (c) => (c.contact.page.en = 'https://sasateguh.com/book')],
  ])('rejects %s in the contact block', (_, change) => {
    const c = valid()
    change(c)
    expect(validateSupport(c)).not.toEqual([])
  })

  it.each([
    ['another email', 'Write to hello@sasateguh.com'],
    ['a mailto link', 'mailto:someone@example.com'],
    ['another wa.me link', 'https://wa.me/60123456789'],
    ['a Gmail mention', 'or our gmail'],
    ['a 019 number', 'call 019-555 1234'],
    ['another 01x number', 'call 012-345 6789'],
    ['a +60 number', 'call +60 13-456 7890'],
    ['another link', 'see https://example.com'],
    ['a home address', 'visit us in Batu Kurau'],
    ['a ringgit price', 'from RM 500'],
    ['a ringgit price without a space', 'from RM500'],
    ['a dollar price', 'only $99'],
    ['USD', 'priced in USD'],
    ['a MYR price', 'MYR 300 flat'],
    ['free as an offer', 'free installation'],
    ['percuma as an offer', 'pemasangan percuma'],
    ['#1', 'the #1 installer'],
    ['terbaik', 'pemasang terbaik'],
    ['best', 'the best team'],
    ['nombor satu', 'nombor satu di Malaysia'],
    ['number one', 'number one in Malaysia'],
    ['termurah', 'harga termurah'],
    ['cheapest', 'the cheapest'],
    ['leading', 'a leading studio'],
    ['top-rated', 'top-rated studio'],
  ])('rejects %s in any text', (_, text) => {
    expect(validateSupport(withText(text))).not.toEqual([])
  })

  it('checks every language and every text field, not just one', () => {
    const c = valid()
    c.demo.ms.cta = 'Pemasang terbaik'
    expect(validateSupport(c)).not.toEqual([])
    const d = valid()
    d.labels.en.page = 'Book at https://example.com'
    expect(validateSupport(d)).not.toEqual([])
  })

  it('still checks text in a disabled config, so switching it back on cannot publish bad text', () => {
    const c = withText('the best team')
    c.enabled = false
    expect(validateSupport(c)).not.toEqual([])
  })

  it('loadSupport throws on a bad config and names the problem', () => {
    expect(() => loadSupport(root, withText('from RM500'))).toThrow(/docs\/support\.json.*price/s)
  })
})
