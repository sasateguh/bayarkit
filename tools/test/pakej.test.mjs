import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageFiles } from '../pakej.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const registry = JSON.parse(readFileSync(`${root}gateways/registry.json`, 'utf8'))
const readme = (pkg) => new Map(packageFiles(root, registry)).get(`${root}packages/${pkg}/README.md`)

describe('generated package READMEs', () => {
  it('an adapter that charges in another currency names it, and never shows ringgit or sen', () => {
    const gw = { ...registry.gateways.find((g) => g.adapter), id: 'demo' }
    gw.adapter = { ...gw.adapter, package: '@bayarkit/paddle', currency: 'USD' }
    const text = new Map(
      packageFiles(root, { gateways: [...registry.gateways.filter((g) => g.id !== 'paddle'), gw] }),
    )
    const out = text.get(`${root}packages/paddle/README.md`)
    expect(out).toContain("{ reference, amount, currency: 'USD' }")
    expect(out).toContain('USD 10.50 = 1050')
    expect(out).not.toMatch(/RM10\.50|integer sen|sen integer/)
  })

  it('a ringgit adapter keeps sen and an Expected without a currency', () => {
    const out = readme('toyyibpay')
    expect(out).toContain('amounts are integer sen (RM10.50 = 1050)')
    expect(out).toContain('{ reference, amount })')
  })

  it('PayPal shows the capture step and says approval is not payment', () => {
    const out = readme('paypal')
    expect(out).toContain('await gateway.capturePayment(')
    expect(out).toContain('`APPROVED`: not paid')
    expect(out).toContain('`APPROVED`: belum dibayar')
    expect(out).not.toMatch(/RM10\.50|integer sen|sen integer/)
  })

  it('Paddle says where the return and callback URLs are set instead', () => {
    const out = readme('paddle')
    expect(out).toContain('default payment link')
    expect(out).toContain("currency: 'USD' }")
    expect(out).not.toMatch(/RM10\.50|integer sen|sen integer/)
  })
})
