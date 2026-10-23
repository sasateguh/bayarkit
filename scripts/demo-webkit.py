#!/usr/bin/env python3
# The demo on WebKit iPhone 13, light + dark, BM + EN: no horizontal scroll, tap targets >= 24 px, no console errors,
# and the forged / paid flows end in the right state. Needs `npm run demo` running and Python Playwright with WebKit.
# Not part of the gate (CI runners have no WebKit); run it after any change to examples/demo.
#   python3 scripts/demo-webkit.py <screenshot dir> [base url]
import sys
from playwright.sync_api import sync_playwright
out = sys.argv[1]
base = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:4317'
problems = []
with sync_playwright() as p:
    b = p.webkit.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(**p.devices['iPhone 13'], color_scheme=scheme)
        pg = ctx.new_page()
        errors = []
        # Playwright's screenshot injects an inline style (caret hiding) that the page's CSP correctly refuses; measured
        # 23 Oct 2026: 0 errors before the first screenshot, 1 per screenshot after. That one message is not the page's.
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Refused to apply a stylesheet' not in m.text else None)
        for prefix in ['', '/en']:
            pg.goto(base + prefix + '/')
            pg.select_option('#gateway', 'ipay88')
            pg.fill('#amount', '12.30')
            def check(name):
                w = pg.evaluate('[document.documentElement.scrollWidth, window.innerWidth]')
                if w[0] > w[1]: problems.append(f'{scheme}{prefix} {name}: scrollWidth {w[0]} > {w[1]}')
                pg.screenshot(path=f'{out}/{scheme}{prefix.replace("/","-")}-{name}.png', full_page=True)
            check('home')
            pg.click('form button[type=submit]')
            pg.wait_for_url('**/pay/**')
            check('pay')
            pg.click('button.choice.forge')
            pg.wait_for_url('**/order/**')
            check('order-forged')
            assert pg.locator('.status.notPaid').count() == 1
            pg.click('a.button')
            pg.select_option('#gateway', 'chip')
            pg.click('form button[type=submit]')
            pg.click('button.choice.pay')
            pg.wait_for_url('**/order/**')
            assert pg.locator('.status.paid').count() == 1
            check('order-paid')
            # tap targets
            small = pg.evaluate("[...document.querySelectorAll('a,button,select,input')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height<24}).map(e=>e.outerHTML.slice(0,60))")
            if small: problems.append(f'{scheme}{prefix} small targets: {small}')
        if errors: problems.append(f'{scheme} console errors: {errors}')
        ctx.close()
    b.close()
print('PROBLEMS:' if problems else 'OK: no overflow, no console errors, flows pass (light+dark, BM+EN)')
for x in problems: print(' ', x)
sys.exit(1 if problems else 0)
