import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertText, backlog, backlogLine, runCheck, selectSources } from '../rujukan.mjs'

// Synthetic registry and pages only: no network, no third-party text.
const registry = {
  gateways: [
    {
      id: 'alpha',
      sources: [
        { id: 'one', url: 'https://alpha.example/one' },
        { id: 'two', url: 'https://alpha.example/two' },
      ],
    },
    { id: 'beta', sources: [{ id: 'one', url: 'https://beta.example/one' }] },
  ],
}
const page = (word) => `${word} `.repeat(60)

let snapshots
let pages
const fetchText = async (source) => pages[source.url]
const run = (state, lock, day, extra = {}) =>
  runCheck({ sources: selectSources(registry, extra.only), lock, state, fetchText, snapshots, day, ...extra })

beforeEach(() => {
  snapshots = mkdtempSync(join(tmpdir(), 'rujukan-test-'))
  pages = {
    'https://alpha.example/one': page('one'),
    'https://alpha.example/two': page('two'),
    'https://beta.example/one': page('beta'),
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(snapshots, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('rujukan check --only', () => {
  it('selects one source with <gateway>/<source>, a whole gateway with <gateway>, nothing for an unknown name', () => {
    expect(selectSources(registry, 'alpha/two').map((s) => s.key)).toEqual(['alpha/two'])
    expect(selectSources(registry, 'alpha').map((s) => s.key)).toEqual(['alpha/one', 'alpha/two'])
    expect(selectSources(registry, null)).toHaveLength(3)
    expect(selectSources(registry, 'alpha/three')).toEqual([])
  })

  it('accepts only the named source with --update --only <gateway>/<source>', async () => {
    const state = {}
    const lock = {}
    await run(state, lock, '2026-10-27')
    pages['https://alpha.example/one'] = page('uno')
    pages['https://alpha.example/two'] = page('dos')
    await run(state, lock, '2026-10-28')
    const before = lock['alpha/two'].sha256
    await run(state, lock, '2026-11-07', { only: 'alpha/one', update: true })
    expect(lock['alpha/one'].since).toBe('2026-11-07')
    expect(lock['alpha/two'].sha256).toBe(before)
    expect(Object.keys(state.since)).toEqual(['alpha/two'])
  })

  it('exits 64 for an --only that names nothing, before fetching or writing anything', () => {
    const cli = fileURLToPath(new URL('../rujukan.mjs', import.meta.url))
    const r = spawnSync(process.execPath, [cli, 'check', '--only', 'no-such-gateway/x'], {
      env: { ...process.env, RUJUKAN_SNAPSHOTS: snapshots },
      encoding: 'utf8',
    })
    expect(r.status).toBe(64)
  })
})

describe('rujukan backlog', () => {
  it('remembers the day a change was first seen, through later changes, until it is accepted', async () => {
    const state = {}
    const lock = {}
    await run(state, lock, '2026-10-27')
    expect(backlogLine(state)).toBe('backlog: 0 pending')
    pages['https://beta.example/one'] = page('beta2')
    expect((await run(state, lock, '2026-10-28')).fresh).toHaveLength(1)
    pages['https://alpha.example/two'] = page('two2')
    await run(state, lock, '2026-10-30')
    pages['https://beta.example/one'] = page('beta3')
    const third = await run(state, lock, '2026-11-02')
    expect(third.fresh).toHaveLength(1)
    expect(third.pending).toHaveLength(1)
    expect(state.since).toEqual({ 'beta/one': '2026-10-28', 'alpha/two': '2026-10-30' })
    expect(backlog(state).map((b) => b.key)).toEqual(['beta/one', 'alpha/two'])
    expect(backlogLine(state)).toBe('backlog: 2 pending, oldest 2026-10-28 beta/one')
    await run(state, lock, '2026-11-03', { only: 'beta', update: true })
    expect(backlogLine(state)).toBe('backlog: 1 pending, oldest 2026-10-30 alpha/two')
  })

  it('drops a change when the page goes back to the reviewed text', async () => {
    const state = {}
    const lock = {}
    await run(state, lock, '2026-10-27')
    pages['https://alpha.example/one'] = page('flip')
    await run(state, lock, '2026-10-28')
    pages['https://alpha.example/one'] = page('one')
    await run(state, lock, '2026-10-29')
    expect(backlogLine(state)).toBe('backlog: 0 pending')
    expect(state.reported['alpha/one']).toBeUndefined()
  })

  it('dates changes reported before `since` existed from the reviewed copy, or today when it is missing', async () => {
    const lock = {}
    await run({}, lock, '2026-10-20')
    const sha = lock['alpha/one'].sha256.slice(0, 12)
    const was = join(snapshots, 'alpha', `one.${sha}.txt`)
    mkdirSync(join(snapshots, 'alpha'), { recursive: true })
    writeFileSync(was, 'reviewed text')
    const t = Date.parse('2026-10-27T02:53:00Z') / 1000
    utimesSync(was, t, t)
    const state = { checked: {}, reported: { 'alpha/one': 'f'.repeat(64), 'alpha/two': 'e'.repeat(64) } }
    await run(state, lock, '2026-11-07', { only: 'beta' })
    expect(state.since).toEqual({ 'alpha/one': '2026-10-27', 'alpha/two': '2026-11-07' })
  })
})

describe('rujukan alert', () => {
  const opts = { day: '2026-11-07', root: '~/bayarkit', snapshots: '~/.local/state/bayarkit/rujukan' }
  const waiting = () => ({
    since: { 'alpha/one': '2026-10-27', 'alpha/two': '2026-11-01', 'beta/one': '2026-11-07' },
    last: { day: '2026-11-07', fresh: ['beta/one'], failed: [] },
  })

  it('says how many changed, how many wait, since when, and what to do', () => {
    const state = waiting()
    const text = alertText(state, opts)
    expect(text).toContain('1 baharu berubah, 2 menunggu semakan (tertua 27 Okt: alpha/one, 11 hari)')
    expect(text).toContain('Baharu: beta/one')
    expect(text).toContain('check --update --only <gw>/<src>')
    expect(text).toContain('~/.local/state/bayarkit/rujukan/<gw>/<src>.<sha>.txt')
    expect(text.split('\n').length).toBeLessThanOrEqual(12)
    expect(state.reminded).toBe('2026-11-07')
  })

  it('reminds about a week-old backlog without a new change, at most once a week', () => {
    const state = { ...waiting(), last: { day: '2026-11-07', fresh: [], failed: [] } }
    expect(alertText(state, opts)).toContain('0 baharu berubah, 3 menunggu semakan')
    expect(alertText(state, { ...opts, day: '2026-11-10' })).toBe('')
    expect(alertText(state, { ...opts, day: '2026-11-14' })).toContain('menunggu semakan')
  })

  it('stays quiet when nothing is new and the oldest change is under a week old', () => {
    const state = { since: { 'alpha/one': '2026-11-02' }, last: { day: '2026-11-07', fresh: [], failed: [] } }
    expect(alertText(state, opts)).toBe('')
    expect(state.reminded).toBeUndefined()
    expect(alertText({ since: {}, last: { day: '2026-11-07', fresh: [], failed: [] } }, opts)).toBe('')
  })

  it('gives failed sources their own alert pointing at the registry', () => {
    const state = { since: {}, last: { day: '2026-11-07', fresh: [], failed: ['alpha/one: HTTP 404'] } }
    const text = alertText(state, { ...opts, failed: true })
    expect(text).toContain('1 sumber')
    expect(text).toContain('alpha/one: HTTP 404')
    expect(text).toContain('gateways/registry.json')
    expect(alertText(waiting(), { ...opts, failed: true })).toBe('')
  })
})
