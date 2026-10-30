#!/usr/bin/env python3
# The demo on WebKit: iPhone 13 and a 1440 px desktop, light + dark, BM + EN.
#   every page: no horizontal scroll, no console errors, the Sasa Teguh seal present (three contact links, in the flow
#   of the page, not over any button, form or the simulated gateway panel);
#   phone: the four scenarios (forged / paid / another order's callback / unpaid) end in the right state, 404 is a
#   branded page, tap targets >= 24 px, the theme switch (a link + cookie, no JavaScript) changes the page and back,
#   and the page has not crashed 8 s after loading (WebKit crashes on animated filters a few seconds in).
# Before the browser, plain HTTP (BM + EN home, CSS): security headers and a CSP that allows no script, no-transform on
#   HTML, no Cloudflare analytics beacon, the seal linking to exactly the contacts in docs/support.json and no other
#   contact link on the page; on the hosted demo also compression and HSTS.
# Needs `npm run demo` running and Python Playwright with WebKit.
# Not part of the gate (CI runners have no WebKit); run it after any change to examples/demo.
#   python3 scripts/demo-webkit.py <screenshot dir> [base url]
import gzip
import json
import sys
import urllib.request
import zlib
from html.parser import HTMLParser
from pathlib import Path

from playwright.sync_api import sync_playwright
out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:4317'
problems = []

# The seal's box against everything it must never cover; also how it is positioned and how many links it carries.
SEAL = """() => {
  const s = document.querySelector('.seal')
  if (!s) return {missing: true}
  const r = s.getBoundingClientRect(), pos = getComputedStyle(s).position
  const hit = [...document.querySelectorAll('main button, main form, main input, main select, .gw, .help a, header a')]
    .filter(e => { const b = e.getBoundingClientRect()
      return b.width > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top })
    .map(e => e.outerHTML.slice(0, 50))
  return {pos, links: s.querySelectorAll('a').length, hit}
}"""


def page_checks(pg, tag, name, wait=800):
    w = pg.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
    if w[0] > w[1]: problems.append(f'{tag} {name}: scrollWidth {w[0]} > {w[1]}')
    s = pg.evaluate(SEAL)
    if s.get('missing'): problems.append(f'{tag} {name}: no seal')
    else:
        if s['pos'] in ('fixed', 'sticky', 'absolute'): problems.append(f'{tag} {name}: seal is position:{s["pos"]}')
        if s['links'] != 3: problems.append(f'{tag} {name}: seal has {s["links"]} links, not 3')
        if s['hit']: problems.append(f'{tag} {name}: seal overlaps {s["hit"]}')
    pg.wait_for_timeout(wait)  # the arrival animation (checks, stamp) settles before the picture
    pg.screenshot(path=f'{out}/{tag.replace("/", "-")}-{name}.png', full_page=True)


def watch(pg, errors, crashed):
    # Playwright's screenshot injects an inline style (caret hiding) that the page's CSP correctly refuses; measured
    # 23 Oct 2026: 0 errors before the first screenshot, 1 per screenshot after. That one message is not the page's.
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Refused to apply a stylesheet' not in m.text else None)
    pg.on('crash', lambda *_: crashed.append(1))


def start(pg, prefix, gateway, amount=None):
    pg.goto(base + prefix + '/')
    pg.select_option('#gateway', gateway)
    if amount: pg.fill('#amount', amount)
    pg.click('form button[type=submit]')
    pg.wait_for_url('**/pay/**')


# Without a browser first: what every visitor receives. Compression and HSTS come from traefik, so they are checked
# only on the hosted demo (https); the local `npm run demo` serves neither.
remote = base.startswith('https:')
support = json.loads((Path(__file__).resolve().parent.parent / 'docs' / 'support.json').read_text())

SAFARI = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
          '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')


def get(path, encoding='gzip, br', accept='text/html,*/*'):
    req = urllib.request.Request(base + path, headers={
        'User-Agent': SAFARI, 'Accept': accept, 'Accept-Encoding': encoding})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()


class Links(HTMLParser):
    """Every href on the page, and the ones inside the seal (<aside class="seal">) separately."""

    def __init__(self):
        super().__init__()
        self.all, self.seal, self.depth = [], [], 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.depth: self.depth += 1
        elif tag == 'aside' and 'seal' in (a.get('class') or '').split(): self.depth = 1
        if tag == 'a' and a.get('href'):
            self.all.append(a['href'])
            if self.depth: self.seal.append(a['href'])

    def handle_endtag(self, tag):
        if self.depth: self.depth -= 1


def is_contact(href):
    return href.startswith('mailto:') or '//wa.me/' in href or href.rstrip('/').endswith('/contact')


for path in ('/', '/en', '/demo.css'):
    status, h, body = get(path)
    if status != 200: problems.append(f'{path}: HTTP {status}')
    enc = h.get('content-encoding', '')
    if remote and enc not in ('gzip', 'br', 'zstd'): problems.append(f'{path}: not compressed (content-encoding "{enc}")')
    for name, want in (('x-content-type-options', 'nosniff'), ('x-frame-options', 'DENY')):
        if h.get(name) != want: problems.append(f'{path}: {name} is "{h.get(name)}", not "{want}"')
    if not h.get('referrer-policy'): problems.append(f'{path}: no referrer-policy')
    if remote and not h.get('strict-transport-security'): problems.append(f'{path}: no HSTS')
    if path == '/demo.css': continue
    csp = h.get('content-security-policy', '')
    if "default-src 'none'" not in csp: problems.append(f"{path}: CSP lacks default-src 'none': {csp!r}")
    if 'script-src' in csp or 'unsafe-' in csp: problems.append(f'{path}: CSP allows script or unsafe-*: {csp!r}')
    if 'no-transform' not in h.get('cache-control', ''): problems.append(f'{path}: HTML without no-transform')

for path, lang in (('/', 'ms'), ('/en', 'en')):
    _, h, raw = get(path, encoding='identity')
    if h.get('content-encoding') == 'gzip': raw = gzip.decompress(raw)
    elif h.get('content-encoding') == 'deflate': raw = zlib.decompress(raw)
    html = raw.decode('utf-8', 'replace')
    if 'cloudflareinsights' in html: problems.append(f'{path}: Cloudflare beacon injected')
    p = Links()
    p.feed(html)
    c = support['contact']
    want = [c['page'][lang], f'mailto:{c["email"]}', c['whatsapp']['url']] if support.get('enabled') else []
    if sorted(p.seal) != sorted(want): problems.append(f'{path}: seal links {p.seal}, config says {want}')
    stray = [x for x in p.all if is_contact(x) and x not in want]
    if stray: problems.append(f'{path}: contact links not from docs/support.json: {stray}')


with sync_playwright() as p:
    b = p.webkit.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(**p.devices['iPhone 13'], color_scheme=scheme)
        pg = ctx.new_page()
        errors, crashed = [], []
        watch(pg, errors, crashed)
        for prefix in ['', '/en']:
            tag = f'{scheme}{prefix}'
            pg.goto(base + prefix + '/')
            # crash sweep: scroll to the bottom, then wait 8 s on the page before anything else
            pg.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
            pg.wait_for_timeout(8000)
            if crashed: problems.append(f'{tag}: WebKit crashed within 8 s of loading home'); break
            pg.evaluate('window.scrollTo(0, 0)')
            pg.select_option('#gateway', 'ipay88')
            pg.fill('#amount', '12.30')
            page_checks(pg, tag, 'home')
            pg.click('form button[type=submit]')
            pg.wait_for_url('**/pay/**')
            page_checks(pg, tag, 'pay')
            pg.click('button.choice.forge')
            pg.wait_for_url('**/order/**')
            page_checks(pg, tag, 'order-forged')
            assert pg.locator('.status.notPaid').count() == 1
            # all four checks on the page, the two that did not run included (a stray rule once moved them off screen)
            on_page = pg.evaluate("[...document.querySelectorAll('.step')].filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.left>=0&&r.top+scrollY>=0}).length")
            if on_page != 4: problems.append(f'{tag} order-forged: {on_page} of 4 checks on the page')
            pg.click('a.button')
            pg.select_option('#gateway', 'chip')
            pg.click('form button[type=submit]')
            pg.click('button.choice.pay')
            pg.wait_for_url('**/order/**')
            assert pg.locator('.status.paid').count() == 1
            page_checks(pg, tag, 'order-paid')
            # another order's paid callback: refused at the third check (reference + amount)
            pg.click('a.button')
            pg.select_option('#gateway', 'billplz')
            pg.click('form button[type=submit]')
            pg.wait_for_url('**/pay/**')
            page_checks(pg, tag, 'pay-four-choices')
            pg.click('button.choice.swap')
            pg.wait_for_url('**/order/**')
            assert pg.locator('.status.notPaid').count() == 1 and pg.locator('.step.fail').count() == 1
            page_checks(pg, tag, 'order-swapped')
            # a signed callback for an unpaid payment: refused at the third check (the gateway says not paid)
            pg.click('a.button')
            start(pg, prefix, 'toyyibpay')
            pg.click('button.choice.decline')
            pg.wait_for_url('**/order/**')
            assert pg.locator('.status.notPaid').count() == 1
            page_checks(pg, tag, 'order-declined')
            # a missing page is a branded 404 with a way back
            seen = len(errors)
            pg.goto(base + prefix + '/order/NOPE')
            assert pg.locator('.oops a.button').count() == 1
            page_checks(pg, tag, 'not-found')
            # WebKit logs the document's own 404 status as an error; that one is expected here, nothing else is.
            errors[seen:] = [e for e in errors[seen:] if 'status of 404' not in e]
            # tap targets
            small = pg.evaluate("[...document.querySelectorAll('a,button,select,input')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height<24}).map(e=>e.outerHTML.slice(0,60))")
            if small: problems.append(f'{tag} small targets: {small}')
            # the theme switch: pick the other theme (after scrolling, as a visitor would), the page follows and comes
            # back to the same path; "system" clears the choice again
            other = 'dark' if scheme == 'light' else 'light'
            pg.goto(base + prefix + '/')
            bg = lambda: pg.evaluate('getComputedStyle(document.documentElement).backgroundColor')
            before = bg()
            pg.evaluate('window.scrollTo(0, 200)')
            with pg.expect_navigation():  # a 303 back to this page: wait for the new document, not the old one
                pg.click(f'.theme a[href*="set={other}"]')
            if pg.evaluate('document.documentElement.dataset.theme') != other or bg() == before or not pg.url.rstrip('/').endswith(base.split('//')[1] + prefix):
                problems.append(f'{tag} theme switch to {other}: theme={pg.evaluate("document.documentElement.dataset.theme")} url={pg.url}')
            page_checks(pg, f'{tag}-switched', 'home')
            with pg.expect_navigation():
                pg.click('.theme a[href*="set=system"]')
            if pg.evaluate('document.documentElement.dataset.theme') != 'system' or bg() != before:
                problems.append(f'{tag} theme back to system did not restore the page')
        if crashed: problems.append(f'{scheme}: WebKit crashed')
        if errors: problems.append(f'{scheme} console errors: {errors}')
        ctx.close()
    # desktop: the same pages at 1440 px, the seal still a line in the page and never over the gateway panel
    for scheme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, color_scheme=scheme)
        pg = ctx.new_page()
        errors, crashed = [], []
        watch(pg, errors, crashed)
        for prefix in ['', '/en']:
            tag = f'desktop-{scheme}{prefix}'
            pg.goto(base + prefix + '/')
            page_checks(pg, tag, 'home')
            start(pg, prefix, 'toyyibpay', '25.00')
            page_checks(pg, tag, 'pay')
            pg.click('button.choice.pay')
            pg.wait_for_url('**/order/**')
            assert pg.locator('.status.paid').count() == 1
            page_checks(pg, tag, 'order-paid')
            seen = len(errors)
            pg.goto(base + prefix + '/order/NOPE')
            page_checks(pg, tag, 'not-found')
            errors[seen:] = [e for e in errors[seen:] if 'status of 404' not in e]
        if crashed: problems.append(f'desktop {scheme}: WebKit crashed')
        if errors: problems.append(f'desktop {scheme} console errors: {errors}')
        ctx.close()
    b.close()
print('PROBLEMS:' if problems else 'OK: headers + seal links, no overflow, no console errors, no crash in 8 s, seal in place, theme switch, flows pass (iPhone 13 + 1440 px, light+dark, BM+EN)')
for x in problems: print(' ', x)
sys.exit(1 if problems else 0)
