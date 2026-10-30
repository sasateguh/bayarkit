import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageFiles } from '../pakej.mjs'
import { fillSupport, SUPPORT_READMES, supportSection } from '../support.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const registry = JSON.parse(readFileSync(`${root}gateways/registry.json`, 'utf8'))

// A frozen config, so these tests pin the shape of the section rather than today's wording in docs/support.json.
const config = (enabled = true) => ({
  enabled,
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
    en: { heading: 'Frozen heading EN', body: 'Frozen body EN.' },
    ms: { heading: 'Frozen heading MS', body: 'Frozen body MS.' },
  },
})

const links = (md) => [...md.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
const OPEN = '<!-- support:help'
const CLOSE = '<!-- /support:help -->'

describe('support section in Markdown', () => {
  it('has the heading, the body and exactly the three contacts, in the reader’s language', () => {
    const en = supportSection(config(), 'en')
    expect(en).toContain('## Frozen heading EN')
    expect(en).toContain('Frozen body EN.')
    expect(links(en)).toEqual([
      'https://sasateguh.com/contact',
      'mailto:admin@sasateguh.com',
      'https://wa.me/60177629379',
    ])
    const ms = supportSection(config(), 'ms')
    expect(ms).toContain('## Frozen heading MS')
    expect(links(ms)[0]).toBe('https://sasateguh.com/ms/contact')
  })

  it('is empty when the offer is switched off', () => {
    expect(supportSection(config(false), 'en')).toBe('')
  })

  it('replaces whatever sits between the markers, so a hand edit is overwritten (and skills --check sees it)', () => {
    const section = supportSection(config(), 'en')
    const edited = `# Title\n\n${OPEN} (generated) -->\n## Hand edit hello@example.com\n${CLOSE}\n\nTail\n`
    const out = fillSupport(edited, section, 'X.md')
    expect(out).not.toContain('hello@example.com')
    expect(out).toContain(section)
    expect(out.startsWith('# Title\n\n')).toBe(true)
    expect(out.endsWith(`${CLOSE}\n\nTail\n`)).toBe(true)
    expect(fillSupport(out, section, 'X.md')).toBe(out)
    expect(fillSupport(out, '', 'X.md')).toBe(`# Title\n\n${OPEN} (generated) -->\n${CLOSE}\n\nTail\n`)
  })

  it('refuses a README without the markers instead of skipping it', () => {
    expect(() => fillSupport('# no markers\n', 'x', 'X.md')).toThrow(/X\.md: support:help markers missing/)
  })

  it('the repository and PHP READMEs carry the block, once, in their own language', () => {
    expect(Object.keys(SUPPORT_READMES).sort()).toEqual([
      'README.md',
      'README.ms.md',
      'php/README.md',
      'php/README.ms.md',
    ])
    for (const file of Object.keys(SUPPORT_READMES)) {
      const text = readFileSync(`${root}${file}`, 'utf8')
      expect(text.split(OPEN).length, file).toBe(2)
      expect(text.split(CLOSE).length, file).toBe(2)
      expect(text, file).not.toMatch(/hello@sasateguh|sasateguh\.com\/(ms\/)?book/)
    }
  })
})

describe('support section in package READMEs', () => {
  const readmes = (support) => packageFiles(root, registry, support).filter(([p]) => p.endsWith('README.md'))

  it('every package README has the section in English and in Malay', () => {
    const files = readmes(config())
    expect(files.length).toBeGreaterThan(2)
    for (const [path, text] of files) {
      expect(text, path).toContain('## Frozen heading EN')
      expect(text, path).toContain('## Frozen heading MS')
      // English before the Malay half, Malay inside it.
      expect(text.indexOf('## Frozen heading EN'), path).toBeLessThan(text.indexOf('## Bahasa Melayu'))
      expect(text.indexOf('## Frozen heading MS'), path).toBeGreaterThan(text.indexOf('## Bahasa Melayu'))
    }
  })

  it('switched off: no section in any package README', () => {
    for (const [path, text] of readmes(config(false))) {
      expect(text, path).not.toContain('Frozen heading')
      expect(text, path).not.toContain('admin@sasateguh.com')
    }
  })

  it('a config that may not be published stops the generator', () => {
    const bad = config()
    bad.readme.en.body = 'Write to hello@sasateguh.com'
    expect(() => packageFiles(root, registry, bad)).toThrow(/cannot be published/)
  })
})
