import { describe, expect, it } from 'vitest'
import { withoutTrailingSlashes } from '../src/index.js'

describe('withoutTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(withoutTrailingSlashes('https://api.example/v3///')).toBe('https://api.example/v3')
    expect(withoutTrailingSlashes('https://api.example/v3')).toBe('https://api.example/v3')
    expect(withoutTrailingSlashes('https://api.example//v3/')).toBe('https://api.example//v3')
    expect(withoutTrailingSlashes('///')).toBe('')
    expect(withoutTrailingSlashes('')).toBe('')
  })

  it('stays linear on a long run of slashes that is not at the end (the regex it replaces was quadratic)', () => {
    const evil = `${'/'.repeat(200_000)}x`
    const started = performance.now()
    expect(withoutTrailingSlashes(evil)).toBe(evil)
    expect(performance.now() - started).toBeLessThan(50)
  })
})
