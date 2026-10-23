import { createHash } from 'node:crypto'
import { callbackFromFields, confirmPayment, GatewayError, readCallback } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeEghl } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import {
  CALLBACK_REPLY,
  eghl,
  eghlHash,
  eghlHashOf,
  HASHVALUE_FIELDS,
  HASHVALUE2_FIELDS,
  SALE_HASH_FIELDS,
  senOf,
} from '../src/index.js'

const keys = { serviceId: 'SIT', merchantPassword: 'fake-password' }
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

gatewayConformance('eghl', async () => {
  const fake = await startFakeEghl({ serviceId: keys.serviceId, password: keys.merchantPassword })
  return {
    fake,
    gateway: eghl({ ...keys, environment: 'sandbox', baseUrl: fake.url, fallbackCustomerIp: '127.0.0.1' }),
  }
})

// Official public test vector: bitbucket.org/eghl/eghl-omnipay @0b2981e tests/GatewayTest.php lines 16–17, 35–50.
// `sit12345` is eGHL's published test-merchant password, not a secret.
const OMNI_PASSWORD = 'sit12345' // gitleaks:allow (official public test-merchant password)
const OMNI_RESPONSE = {
  TransactionType: 'SALE',
  PymtMethod: 'DD',
  ServiceID: 'SIT',
  PaymentID: '15434756362e18a914ef',
  OrderNumber: 'OMNI001',
  Amount: '10.00',
  CurrencyCode: 'MYR',
  HashValue: 'ca50fa8361ba6e09937e632af4a4ce5b0a74fa687dbcd9c6c98f8ad61c62bb36',
  HashValue2: 'b09dd0905ab5d25be8d0d00d5bc5f556befb9d9a5a88c0eca87b2e504fc9667d',
  TxnID: 'SIT15434756362e18a914ef',
  IssuingBank: 'HostSim',
  TxnStatus: '0',
  AuthCode: 'SIT154',
  TxnMessage: 'Transaction Successful',
}
const OMNI_HV2_INPUT = 'sit12345SIT15434756362e18a914efSIT15434756362e18a914ef010.00MYRSIT154OMNI001'

const omniGateway = () => eghl({ serviceId: 'SIT', merchantPassword: OMNI_PASSWORD, environment: 'sandbox' })

describe('eghl: the official Omnipay test vector', () => {
  it('HashValue2 = sha256 of the documented input string, and eghlHashOf builds that string', () => {
    expect(sha(OMNI_HV2_INPUT)).toBe(OMNI_RESPONSE.HashValue2)
    expect(eghlHashOf(OMNI_PASSWORD, HASHVALUE2_FIELDS, OMNI_RESPONSE)).toBe(OMNI_RESPONSE.HashValue2)
    expect(
      OMNI_PASSWORD +
        HASHVALUE2_FIELDS.map((k) => (OMNI_RESPONSE as Record<string, string>)[k] ?? '').join(''),
    ).toBe(OMNI_HV2_INPUT)
  })

  it('legacy HashValue = the same input without OrderNumber', () => {
    expect(sha(OMNI_HV2_INPUT.replace(/OMNI001$/, ''))).toBe(OMNI_RESPONSE.HashValue)
    expect(eghlHashOf(OMNI_PASSWORD, HASHVALUE_FIELDS, OMNI_RESPONSE)).toBe(OMNI_RESPONSE.HashValue)
  })

  it('verifyCallback accepts the official response', () => {
    expect(omniGateway().verifyCallback(callbackFromFields(OMNI_RESPONSE))).toMatchObject({
      id: '15434756362e18a914ef.1000.DD',
      reference: 'OMNI001',
      claimedStatus: 'paid',
    })
  })

  it('a wrong password, or one changed field, does not verify', () => {
    const wrong = eghl({ serviceId: 'SIT', merchantPassword: 'sit12346', environment: 'sandbox' })
    expect(wrong.verifyCallback(callbackFromFields(OMNI_RESPONSE))).toBeNull()
    for (const k of ['TxnID', 'PaymentID', 'TxnStatus', 'Amount', 'AuthCode', 'OrderNumber']) {
      const changed = { ...OMNI_RESPONSE, [k]: `${(OMNI_RESPONSE as Record<string, string>)[k]}1` }
      expect(omniGateway().verifyCallback(callbackFromFields(changed)), k).toBeNull()
    }
    expect(omniGateway().verifyCallback(callbackFromFields({ ...OMNI_RESPONSE, Param6: 'x' }))).toBeNull()
  })
})

describe('eghl: contradictions in the official code (spec §9, §10)', () => {
  const password = keys.merchantPassword
  const gateway = eghl({ ...keys, environment: 'sandbox' })
  const base = {
    PymtMethod: 'DD',
    ServiceID: 'SIT',
    PaymentID: 'ORDER77',
    OrderNumber: 'ORDER77',
    Amount: '25.00',
    CurrencyCode: 'MYR',
    TxnID: 'SITORDER77',
    TxnStatus: '0',
    AuthCode: 'A1',
    TxnMessage: 'Transaction Successful',
  }
  const signed = (fields: Record<string, string>, names: readonly string[] = HASHVALUE2_FIELDS) =>
    callbackFromFields({ ...fields, HashValue2: eghlHashOf(password, names, fields) })

  it('C1: the Magento (no Param7) and OpenCart (no Param6/7) field lists are NOT accepted when Param6/7 are set', () => {
    const withParams = { ...base, Param6: 'P6', Param7: 'P7' }
    const magento = HASHVALUE2_FIELDS.filter((k) => k !== 'Param7')
    const opencart = HASHVALUE2_FIELDS.filter((k) => k !== 'Param6' && k !== 'Param7')
    expect(gateway.verifyCallback(signed(withParams))).not.toBeNull()
    expect(gateway.verifyCallback(signed(withParams, magento))).toBeNull()
    expect(gateway.verifyCallback(signed(withParams, opencart))).toBeNull()
    // With Param6/Param7 empty the three lists give the same hash (the only case the plugins agree on).
    expect(eghlHashOf(password, opencart, base)).toBe(eghlHashOf(password, HASHVALUE2_FIELDS, base))
  })

  it('C2: a callback with only the legacy HashValue is refused', () => {
    const legacyOnly = callbackFromFields({
      ...base,
      HashValue: eghlHashOf(password, HASHVALUE_FIELDS, base),
    })
    expect(gateway.verifyCallback(legacyOnly)).toBeNull()
    // HashValue2 in the HashValue slot (7 fields) is not HashValue2 either.
    expect(gateway.verifyCallback(signed(base, HASHVALUE_FIELDS))).toBeNull()
  })

  it('C3: an Amount with a thousands comma is hashed exactly as received, never comma-stripped first', () => {
    const comma = { ...base, Amount: '1,000.00' }
    expect(gateway.verifyCallback(signed(comma))).toMatchObject({ id: 'ORDER77.100000.DD' })
    const strippedFirst = callbackFromFields({
      ...comma,
      HashValue2: eghlHashOf(password, HASHVALUE2_FIELDS, { ...comma, Amount: '1000.00' }),
    })
    expect(gateway.verifyCallback(strippedFirst)).toBeNull()
    expect(senOf('1,000.00')).toBe(100000)
    expect(senOf('10.5')).toBeNaN()
    expect(senOf('10.505')).toBeNaN()
    expect(senOf('1,00.00')).toBeNaN()
  })

  it('C5: upper-case hex is the same signature', () => {
    const cb = signed(base)
    cb.fields.HashValue2 = (cb.fields.HashValue2 ?? '').toUpperCase()
    expect(gateway.verifyCallback(cb)).not.toBeNull()
  })

  it('§10: the silent sha256(password)-alone result of a missing mandatory field is refused', () => {
    const { TxnID: _drop, ...noTxnId } = base
    expect(gateway.verifyCallback(callbackFromFields({ ...noTxnId, HashValue2: sha(password) }))).toBeNull()
    expect(gateway.verifyCallback(signed(noTxnId))).toBeNull()
    expect(gateway.verifyCallback(signed({ ...base, OrderNumber: '' }))).toBeNull()
  })

  it("§10: values are not rewritten (WooCommerce's ':' → '=>' is not copied)", () => {
    const colon = { ...base, Param6: 'a:b' }
    expect(gateway.verifyCallback(signed(colon))).not.toBeNull()
    const wooRewritten = callbackFromFields({
      ...colon,
      HashValue2: eghlHashOf(password, HASHVALUE2_FIELDS, { ...colon, Param6: 'a=>b' }),
    })
    expect(gateway.verifyCallback(wooRewritten)).toBeNull()
  })

  it("another merchant's ServiceID, another currency, or a PaymentID this adapter never creates is refused", () => {
    expect(gateway.verifyCallback(signed({ ...base, ServiceID: 'XYZ' }))).toBeNull()
    expect(gateway.verifyCallback(signed({ ...base, CurrencyCode: 'SGD' }))).toBeNull()
    expect(gateway.verifyCallback(signed({ ...base, PaymentID: '130#1547432197655ef9' }))).toBeNull()
  })

  it('fields are signed, not bytes: a form body via readCallback and parsed fields both verify', async () => {
    const cb = signed(base)
    const request = new Request('https://shop.example/eghl', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(cb.fields).toString(),
    })
    const read = await readCallback(request)
    expect(gateway.verifyCallback(read)).toMatchObject({ id: 'ORDER77.2500.DD', reference: 'ORDER77' })
    expect(gateway.verifyCallback({ ...cb, rawBody: '' })).toMatchObject({ id: 'ORDER77.2500.DD' })
    expect(CALLBACK_REPLY).toBe('OK')
  })

  it('maps the claimed TxnStatus without ever turning a failure into paid', () => {
    const claim = (TxnStatus: string, TxnMessage = 'x') =>
      gateway.verifyCallback(signed({ ...base, TxnStatus, TxnMessage }))?.claimedStatus
    expect(claim('0')).toBe('paid')
    expect(claim('1')).toBe('failed')
    expect(claim('1', 'Buyer cancelled')).toBe('cancelled')
    expect(claim('2')).toBe('pending')
    expect(claim('10')).toBe('unknown')
  })
})

describe('eghl: createPayment', () => {
  it('builds a GET redirect the gateway accepts (request HashValue), with ringgit, reference as PaymentID and ; URLs', async () => {
    const fake = await startFakeEghl({ serviceId: 'SIT', password: keys.merchantPassword })
    try {
      const gateway = eghl({
        ...keys,
        environment: 'sandbox',
        baseUrl: fake.url,
        fallbackCustomerIp: '127.0.0.1',
      })
      const input = sampleInput({ amount: 1050, returnUrl: 'https://shop.example/r?a=1&b=2' })
      const created = await gateway.createPayment(input)
      expect(created.id).toBe(`${input.reference}.1050`)
      const f = created.raw.fields
      expect(f).toMatchObject({
        TransactionType: 'SALE',
        PymtMethod: 'ANY',
        PaymentID: input.reference,
        OrderNumber: input.reference,
        Amount: '10.50',
        CurrencyCode: 'MYR',
        MerchantReturnURL: 'https://shop.example/r?a=1;b=2',
      })
      expect(f.HashValue).toBe(eghlHashOf(keys.merchantPassword, SALE_HASH_FIELDS, f))
      const res = await fetch(created.url)
      expect(res.status).toBe(200)
      expect(fake.payment(input.reference)).toMatchObject({ fromSale: true, Amount: '10.50' })

      // The same fields as an auto-submitting POST form also work.
      const posted = await gateway.createPayment(sampleInput({ amount: 100 }))
      expect(posted.raw.fields.Amount).toBe('1.00')
      const form = await fetch(posted.raw.action, {
        method: posted.raw.method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(posted.raw.fields).toString(),
      })
      expect(form.status).toBe(200)

      // Paid after the real page flow: the callback + QUERY confirm it.
      fake.markPaid(created.id)
      expect(await confirmPayment(gateway, fake.callbackFor(created.id), input)).toMatchObject({ ok: true })
    } finally {
      await fake.close()
    }
  })

  it('C4: a 45-character IPv6 CustIP is sent and hashed whole (not cut to 20)', async () => {
    const fake = await startFakeEghl({ serviceId: 'SIT', password: keys.merchantPassword })
    try {
      const ip = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255'
      expect(ip).toHaveLength(45)
      const gateway = eghl({ ...keys, environment: 'sandbox', baseUrl: fake.url })
      const created = await gateway.createPayment({ ...sampleInput(), customerIp: ip })
      expect(created.raw.fields.CustIP).toBe(ip)
      expect((await fetch(created.url)).status).toBe(200)
      const cut = { ...created.raw.fields, CustIP: ip.slice(0, 20) }
      expect(eghlHashOf(keys.merchantPassword, SALE_HASH_FIELDS, cut)).not.toBe(created.raw.fields.HashValue)
    } finally {
      await fake.close()
    }
  })

  it('refuses what eGHL cannot take, before anything is sent', async () => {
    const gateway = eghl({ ...keys, environment: 'sandbox', fallbackCustomerIp: '127.0.0.1' })
    const refuse = (o: Parameters<typeof gateway.createPayment>[0]) =>
      expect(gateway.createPayment(o)).rejects.toBeInstanceOf(GatewayError)
    await refuse(sampleInput({ reference: 'A'.repeat(21) }))
    await refuse(sampleInput({ reference: 'ORDER.1' }))
    await refuse(sampleInput({ customer: { name: 'Ali' } }))
    await refuse(sampleInput({ customer: { name: '', email: 'a@example.com' } }))
    await refuse(sampleInput({ returnUrl: 'javascript:alert(1)' }))
    await refuse(sampleInput({ expiresAt: new Date(Date.now() - 1000) }))
    const noIp = eghl({ ...keys, environment: 'sandbox' })
    await expect(noIp.createPayment(sampleInput())).rejects.toMatchObject({ code: 'CUSTOMER_IP' })
  })

  it('expiresAt becomes PageTimeout in seconds, cut to 9999 (earlier, never later)', async () => {
    const now = 1_700_000_000_000
    const gateway = eghl({ ...keys, environment: 'sandbox', fallbackCustomerIp: '127.0.0.1', now: () => now })
    const ten = await gateway.createPayment(sampleInput({ expiresAt: new Date(now + 600_000) }))
    expect(ten.raw.fields.PageTimeout).toBe('600')
    const day = await gateway.createPayment(sampleInput({ expiresAt: new Date(now + 86_400_000) }))
    expect(day.raw.fields.PageTimeout).toBe('9999')
    const none = await gateway.createPayment(sampleInput())
    expect(none.raw.fields.PageTimeout).toBeUndefined()
    expect(none.url.startsWith('https://pay.e-ghl.com/IPGSG/payment.aspx?')).toBe(true)
  })
})

describe('eghl: getPayment (QUERY)', () => {
  const password = keys.merchantPassword
  /** A fetch that answers one QUERY the way merchant-api reads it: url-encoded, signed with the 7-field HashValue. */
  const answering = (o: Record<string, string>, sign = true) => {
    const seen: Record<string, string>[] = []
    const doFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))))
      const body = { ...o, ...(sign ? { HashValue: eghlHashOf(password, HASHVALUE_FIELDS, o) } : {}) }
      return new Response(new URLSearchParams(body).toString(), { status: 200 })
    }) as typeof fetch
    return { doFetch, seen }
  }
  const record = (TxnStatus: string, extra: Record<string, string> = {}) => ({
    ServiceID: 'SIT',
    PaymentID: 'ORDER9',
    Amount: '12.00',
    CurrencyCode: 'MYR',
    TxnID: 'SITORDER9',
    TxnExists: '0',
    TxnStatus,
    AuthCode: 'A9',
    TxnMessage: 'm',
    ...extra,
  })
  const statusFor = async (TxnStatus: string, extra: Record<string, string> = {}) => {
    const { doFetch } = answering(record(TxnStatus, extra))
    return (await eghl({ ...keys, environment: 'sandbox', fetch: doFetch }).getPayment('ORDER9.1200')).status
  }

  it('sends a signed QUERY with the original amount and currency', async () => {
    const { doFetch, seen } = answering(record('0'))
    const p = await eghl({ ...keys, environment: 'sandbox', fetch: doFetch }).getPayment('ORDER9.1200')
    expect(seen[0]).toMatchObject({
      TransactionType: 'QUERY',
      PymtMethod: 'ANY',
      ServiceID: 'SIT',
      PaymentID: 'ORDER9',
      Amount: '12.00',
      CurrencyCode: 'MYR',
      HashValue: eghlHash(password, ['SIT', 'ORDER9', '12.00', 'MYR']),
    })
    expect(p).toMatchObject({ status: 'paid', reference: 'ORDER9', amount: 1200, currency: 'MYR', fee: null })
  })

  it('maps every TxnStatus; only 0 with TxnExists=0 is paid', async () => {
    expect(await statusFor('0')).toBe('paid')
    expect(await statusFor('1')).toBe('failed')
    expect(await statusFor('1', { TxnMessage: 'Buyer cancelled' })).toBe('cancelled')
    expect(await statusFor('2')).toBe('pending')
    expect(await statusFor('-1', { TxnExists: '1' })).toBe('pending')
    expect(await statusFor('9')).toBe('cancelled')
    for (const s of ['10', '15', '16', '31', '99']) expect(await statusFor(s), s).toBe('unknown')
  })

  it('TxnExists is inverted: TxnStatus 0 with TxnExists 1 (or missing) is not paid', async () => {
    expect(await statusFor('0', { TxnExists: '1' })).not.toBe('paid')
    const { TxnExists: _drop, ...noFlag } = record('0')
    const { doFetch } = answering(noFlag)
    const p = await eghl({ ...keys, environment: 'sandbox', fetch: doFetch }).getPayment('ORDER9.1200')
    expect(p.status).not.toBe('paid')
  })

  it('an unsigned or tampered QUERY answer, or a system error, is a GatewayError (never a status)', async () => {
    const unsigned = answering(record('0'), false)
    await expect(
      eghl({ ...keys, environment: 'sandbox', fetch: unsigned.doFetch }).getPayment('ORDER9.1200'),
    ).rejects.toMatchObject({ code: 'RESPONSE_SIGNATURE' })
    const tampered = (async () =>
      new Response(
        new URLSearchParams({
          ...record('0'),
          HashValue: eghlHashOf(password, HASHVALUE_FIELDS, record('1')),
        }).toString(),
      )) as typeof fetch
    await expect(
      eghl({ ...keys, environment: 'sandbox', fetch: tampered }).getPayment('ORDER9.1200'),
    ).rejects.toBeInstanceOf(GatewayError)
    const { doFetch } = answering(record('-2'))
    await expect(
      eghl({ ...keys, environment: 'sandbox', fetch: doFetch }).getPayment('ORDER9.1200'),
    ).rejects.toMatchObject({ code: '-2' })
  })

  it('refuses ids it did not make, and never puts the password in an error', async () => {
    const gateway = eghl({ ...keys, environment: 'sandbox', fetch: answering(record('0')).doFetch })
    for (const id of ['', 'ORDER9', 'ORDER9.12.00', '../x.1', 'ORDER9.1200.dd']) {
      await expect(gateway.getPayment(id), id).rejects.toMatchObject({ code: 'INVALID_ID' })
    }
    const echo = (async () => new Response(`error near ${password}`, { status: 500 })) as typeof fetch
    const err = await eghl({ ...keys, environment: 'sandbox', fetch: echo })
      .getPayment('ORDER9.1200')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(String((err as Error).message)).not.toContain(password)
  })

  it('PymtMethod: asks with the method paid with, then with the method sent when eGHL says -1', async () => {
    const fake = await startFakeEghl({ serviceId: 'SIT', password, queryMethod: 'sent' })
    try {
      const gateway = eghl({
        ...keys,
        environment: 'sandbox',
        baseUrl: fake.url,
        fallbackCustomerIp: '127.0.0.1',
      })
      const input = sampleInput()
      const created = await gateway.createPayment(input)
      fake.markPaid(created.id)
      const result = await confirmPayment(gateway, fake.callbackFor(created.id), input)
      expect(result).toMatchObject({ ok: true })
      const queries = fake.requests
        .filter((r) => r.fields.TransactionType === 'QUERY')
        .map((r) => r.fields.PymtMethod)
      expect(queries).toEqual(['DD', 'ANY'])
    } finally {
      await fake.close()
    }
  })
})
