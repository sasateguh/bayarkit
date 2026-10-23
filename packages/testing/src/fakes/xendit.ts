/**
 * A fake Xendit API (Payment Sessions + the v3 payment request lookup), built from the official docs in
 * `gateways/xendit/spec.md` (not yet measured against a Xendit test-mode account). When someone measures test mode,
 * change this file first so it answers like the real thing, then the adapter.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - auth: `Authorization: Basic base64("<key>:")` with the configured key, else 401 `INVALID_API_KEY` [§1]; the key's
 *   prefix picks the mode, so the fake only accepts `xnd_development_…` keys (it IS test mode) [§1];
 * - JSON in, JSON out; errors are `{ error_code, message }` [§1, AI-SKILL "Conventions"];
 * - `POST /sessions` → 201 with the session object [§2]: required `reference_id` (1-64), `session_type`, `mode`,
 *   `amount`, `currency`, `country`; amount in RINGGIT (major units), > 0 for PAY; return URLs must be HTTPS
 *   (`INVALID_URL`); `expires_at` at least 10 minutes ahead (`INVALID_EXPIRY_DATE`), default 30 minutes [§2];
 * - the fake allows at most two decimals for MYR. The docs only say "the decimal places allowed for the given
 *   currency" (UNCONFIRMED), so this is the fake's assumption, not a documented rule;
 * - no idempotency header exists and `reference_id` uniqueness is not enforced [§6]: every POST is a new session;
 * - `GET /sessions/{id}`, `POST /sessions/{id}/cancel` (only from ACTIVE → `CANCELED`, one L) [§3, §7];
 * - `GET /v3/payment_requests/{id}` REQUIRES `api-version: 2024-11-11` here. The OpenAPI does not mark it required
 *   while the migration guide says v3 "requires" it (contradiction C9); the fake is strict so a test proves the
 *   adapter always sends it;
 * - webhooks: POST, JSON `{ event, business_id, created, data }`, authenticated ONLY by the static
 *   `x-callback-token` header [§4]. Nothing signs the body. `data` of a session event is the session object; of a
 *   `payment.*` event, the payment (with `payment_request_id`, `reference_id`, `request_amount`, `captures`) [§3, §4].
 *
 * The fake's own assumptions (not documented): a paid session's payment request carries the session's `reference_id`
 * and amount; ids are `ps-` + 24 hex (27 characters, as the schema says) and `pr-` / `py-` / `cptr-` + a UUID, as in
 * the official examples.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

export const XENDIT_API_VERSION = '2024-11-11'

type Session = Record<string, unknown> & { payment_session_id: string; status: string }
type PaymentRequest = Record<string, unknown> & { payment_request_id: string; status: string }

export interface FakeXendit extends FakeGateway {
  requests: {
    method: string
    path: string
    body: Record<string, unknown> | null
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record of a session (what `GET /sessions/{id}` answers). */
  session(id: string): Session | undefined
  /** The fake's own record of a payment request (what `GET /v3/payment_requests/{id}` answers). */
  paymentRequest(id: string): PaymentRequest | undefined
  /** Move an ACTIVE session to `EXPIRED` (what Xendit does when `expires_at` passes). */
  expire(id: string): void
  /**
   * A `payment.capture` webhook for this session's payment, claiming `SUCCEEDED` even before `markPaid` (then the
   * fake's payment request stays `REQUIRES_ACTION`). `override` changes fields of `data`; the key `event` changes the
   * event name instead.
   */
  paymentCallbackFor(
    sessionId: string,
    override?: Record<string, unknown>,
  ): ReturnType<FakeGateway['callbackFor']>
}

const BUSINESS_ID = '603f1c4172bbe840979fd408'
const isoNow = () => new Date().toISOString()

export async function startFakeXendit(opts: {
  secretKey: string
  callbackToken: string
}): Promise<FakeXendit> {
  if (!opts.secretKey.startsWith('xnd_development_')) {
    throw new Error('fake Xendit: use a test-mode key (xnd_development_…); the fake is test mode')
  }
  const sessions = new Map<string, Session>()
  const paymentRequests = new Map<string, PaymentRequest>()
  const requests: FakeXendit['requests'] = []
  const expectedAuth = `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      let body: Record<string, unknown> | null = null
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const fail = (status: number, error_code: string, message: string) =>
        send(status, { error_code, message })
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
        } catch {
          requests.push({ method: req.method ?? '', path, body: null, headers: req.headers })
          return fail(400, 'API_VALIDATION_ERROR', 'Request body is not valid JSON')
        }
      }
      requests.push({ method: req.method ?? '', path, body, headers: req.headers })

      if (req.headers.authorization !== expectedAuth) {
        return fail(401, 'INVALID_API_KEY', 'The API key provided is invalid or missing')
      }

      if (req.method === 'POST' && path === '/sessions') {
        const r = create(body ?? {})
        return send(r.status, r.body)
      }
      const get = /^\/sessions\/([A-Za-z0-9-]+)$/.exec(path)
      if (req.method === 'GET' && get) {
        const s = sessions.get(get[1] ?? '')
        return s ? send(200, s) : fail(404, 'DATA_NOT_FOUND', 'Session not found')
      }
      const cancel = /^\/sessions\/([A-Za-z0-9-]+)\/cancel$/.exec(path)
      if (req.method === 'POST' && cancel) {
        const s = sessions.get(cancel[1] ?? '')
        if (!s) return fail(404, 'DATA_NOT_FOUND', 'Session not found')
        if (s.status !== 'ACTIVE') return fail(400, 'INVALID_STATUS', `Session is ${s.status}, not ACTIVE`)
        s.status = 'CANCELED'
        s.updated = isoNow()
        return send(200, s)
      }
      const pr = /^\/v3\/payment_requests\/([A-Za-z0-9-]+)$/.exec(path)
      if (req.method === 'GET' && pr) {
        if (req.headers['api-version'] !== XENDIT_API_VERSION) {
          return fail(400, 'API_VALIDATION_ERROR', `fake Xendit: send api-version: ${XENDIT_API_VERSION}`)
        }
        const p = paymentRequests.get(pr[1] ?? '')
        return p ? send(200, p) : fail(404, 'DATA_NOT_FOUND', 'Payment request not found')
      }
      return fail(404, 'NOT_FOUND', `No route ${req.method} ${path}`)
    })
  })

  function create(b: Record<string, unknown>): { status: number; body: unknown } {
    const bad = (error_code: string, message: string) => ({ status: 400, body: { error_code, message } })
    for (const k of ['reference_id', 'session_type', 'mode', 'amount', 'currency', 'country']) {
      if (b[k] === undefined || b[k] === null) return bad('API_VALIDATION_ERROR', `${k} is required`)
    }
    const ref = b.reference_id
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > 64) {
      return bad('API_VALIDATION_ERROR', 'reference_id must be 1 to 64 characters')
    }
    if (!['PAY', 'SAVE', 'SUBSCRIPTION'].includes(String(b.session_type)))
      return bad('API_VALIDATION_ERROR', 'invalid session_type')
    if (b.session_type !== 'PAY') return bad('SESSION_TYPE_NOT_SUPPORTED', 'fake Xendit only implements PAY')
    if (!['PAYMENT_LINK', 'COMPONENTS'].includes(String(b.mode)))
      return bad('MODE_NOT_SUPPORTED', 'invalid mode')
    if (b.currency !== 'MYR') return bad('INVALID_CURRENCY', 'fake Xendit only speaks MYR')
    if (b.country !== 'MY') return bad('INVALID_COUNTRY', 'fake Xendit only speaks MY')
    const amount = b.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return bad('INVALID_AMOUNT', 'For PAY session type, amount must be greater than zero')
    }
    if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
      return bad('INVALID_AMOUNT', 'Amount must respect the decimal places allowed for the given currency')
    }
    for (const k of ['success_return_url', 'cancel_return_url']) {
      const u = b[k]
      if (u !== undefined && (typeof u !== 'string' || !/^https:\/\/[^\s]+$/.test(u))) {
        return bad('INVALID_URL', `${k} is not a valid HTTPS URL`)
      }
    }
    if (b.capture_method !== undefined && !['AUTOMATIC', 'MANUAL'].includes(String(b.capture_method))) {
      return bad('API_VALIDATION_ERROR', 'invalid capture_method')
    }
    if (b.description !== undefined) {
      const d = b.description
      if (typeof d !== 'string' || d.length < 1 || d.length > 1000)
        return bad('API_VALIDATION_ERROR', 'description must be 1 to 1000 characters')
    }
    const created = Date.now()
    let expiresAt = new Date(created + 30 * 60_000)
    if (b.expires_at !== undefined) {
      const e = typeof b.expires_at === 'string' ? new Date(b.expires_at) : new Date(Number.NaN)
      if (Number.isNaN(e.getTime()) || e.getTime() - created < 10 * 60_000) {
        return bad('INVALID_EXPIRY_DATE', 'expires_at must be at least 10 minutes in the future')
      }
      expiresAt = e
    }
    const id = `ps-${randomBytes(12).toString('hex')}`
    const session: Session = {
      payment_session_id: id,
      created: new Date(created).toISOString(),
      updated: new Date(created).toISOString(),
      reference_id: ref,
      customer_id: null,
      session_type: 'PAY',
      allow_save_payment_method: 'DISABLED',
      currency: 'MYR',
      amount,
      country: 'MY',
      mode: b.mode,
      capture_method: b.capture_method ?? 'AUTOMATIC',
      channel_properties: b.channel_properties ?? {},
      allowed_payment_channels: b.allowed_payment_channels ?? [],
      expires_at: expiresAt.toISOString(),
      locale: b.locale ?? 'en',
      metadata: b.metadata ?? null,
      description: b.description ?? null,
      items: b.items ?? null,
      success_return_url: b.success_return_url ?? null,
      cancel_return_url: b.cancel_return_url ?? null,
      status: 'ACTIVE',
      payment_link_url: `https://dev.xen.to/${randomBytes(6).toString('base64url')}`,
      payment_token_id: null,
      payment_id: null,
      payment_request_id: null,
      latest_payment_request_id: null,
      latest_payment_token_id: null,
      business_id: BUSINESS_ID,
    }
    sessions.set(id, session)
    return { status: 201, body: session }
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const session = (id: string) => {
    const s = sessions.get(id)
    if (!s) throw new Error(`fake Xendit: no session ${id}`)
    return s
  }
  /** The session's payment request, created on first use (REQUIRES_ACTION until markPaid). */
  const requestFor = (s: Session): PaymentRequest => {
    const existing = paymentRequests.get(String(s.latest_payment_request_id ?? ''))
    if (existing) return existing
    const p: PaymentRequest = {
      payment_request_id: `pr-${randomUUID()}`,
      business_id: BUSINESS_ID,
      reference_id: s.reference_id,
      type: 'PAY',
      country: 'MY',
      currency: 'MYR',
      request_amount: s.amount,
      capture_method: s.capture_method,
      channel_code: 'MAYB2U_FPX',
      status: 'REQUIRES_ACTION',
      created: isoNow(),
      updated: isoNow(),
    }
    paymentRequests.set(p.payment_request_id, p)
    s.latest_payment_request_id = p.payment_request_id
    return p
  }
  const webhook = (event: string, data: Record<string, unknown>) => {
    const rawBody = JSON.stringify({ event, business_id: BUSINESS_ID, created: isoNow(), data })
    return {
      fields: {},
      rawBody,
      headers: { 'content-type': 'application/json', 'x-callback-token': opts.callbackToken },
    }
  }

  return {
    url,
    requests,
    session: (id) => sessions.get(id),
    paymentRequest: (id) => paymentRequests.get(id),
    markPaid(id) {
      const s = session(id)
      const p = requestFor(s)
      const capturedAt = isoNow()
      p.status = 'SUCCEEDED'
      p.payment_id = `py-${randomUUID()}`
      p.captures = [
        { capture_id: `cptr-${randomUUID()}`, capture_timestamp: capturedAt, capture_amount: s.amount },
      ]
      p.updated = capturedAt
      s.status = 'COMPLETED'
      s.payment_id = p.payment_id
      s.payment_request_id = p.payment_request_id
      s.updated = capturedAt
    },
    expire(id) {
      const s = session(id)
      if (s.status === 'ACTIVE') {
        s.status = 'EXPIRED'
        s.updated = isoNow()
      }
    },
    /**
     * A `payment_session.completed` webhook claiming success (even before `markPaid`; the fake's record stays
     * ACTIVE). `override` changes fields of `data` (the session object); the key `event` changes the event name.
     */
    callbackFor(id, override = {}) {
      const { event, ...fields } = override
      const s = session(id)
      const data: Record<string, unknown> = {
        ...s,
        status: 'COMPLETED',
        payment_id: s.payment_id ?? `py-${randomUUID()}`,
        payment_request_id: s.payment_request_id ?? `pr-${randomUUID()}`,
        ...fields,
      }
      return webhook(event ?? 'payment_session.completed', data)
    },
    paymentCallbackFor(sessionId, override = {}) {
      const { event, ...fields } = override
      const p = requestFor(session(sessionId))
      const at = isoNow()
      const data: Record<string, unknown> = {
        payment_id: p.payment_id ?? `py-${randomUUID()}`,
        business_id: BUSINESS_ID,
        reference_id: p.reference_id,
        payment_request_id: p.payment_request_id,
        type: 'PAY',
        country: 'MY',
        currency: 'MYR',
        request_amount: p.request_amount,
        capture_method: p.capture_method,
        channel_code: p.channel_code,
        status: 'SUCCEEDED',
        captures: [
          { capture_id: `cptr-${randomUUID()}`, capture_timestamp: at, capture_amount: p.request_amount },
        ],
        payment_details: {},
        created: p.created,
        updated: at,
        ...fields,
      }
      return webhook(typeof event === 'string' ? event : 'payment.capture', data)
    },
    tamper: (cb) => ({
      ...cb,
      headers: { ...cb.headers, 'x-callback-token': flip(cb.headers['x-callback-token'] ?? '') },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
