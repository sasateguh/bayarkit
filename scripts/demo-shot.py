#!/usr/bin/env python3
# Regenerates docs/demo/demo.png + demo.ms.png (the README pictures, EN and BM) from the RUNNING demo, so the picture is never older than the UI:
# WebKit iPhone 13, three screens of one story — the simulated payment page, a forged callback refused, a real payment
# confirmed. Needs `npm run demo` running, Python Playwright with WebKit, and Pillow.
#   python3 scripts/demo-shot.py [base url]
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4317'
docs = Path(__file__).resolve().parent.parent / 'docs' / 'demo'


def shot(pg):
    return Image.open(io.BytesIO(pg.screenshot(full_page=False)))


def render(lang_prefix, out):
  with sync_playwright() as p:
      browser = p.webkit.launch()
      ctx = browser.new_context(**p.devices['iPhone 13'], color_scheme='light')
      pg = ctx.new_page()
      shots = []
      pg.goto(base + lang_prefix + '/')
      pg.select_option('#gateway', 'toyyibpay')
      pg.fill('#amount', '25.00')
      pg.click('form button[type=submit]')
      pg.wait_for_url('**/pay/**')
      shots.append(shot(pg))
      pg.click('button.choice.forge')
      pg.wait_for_url('**/order/**')
      shots.append(shot(pg))
      pg.goto(base + lang_prefix + '/')
      pg.select_option('#gateway', 'toyyibpay')
      pg.fill('#amount', '25.00')
      pg.click('form button[type=submit]')
      pg.wait_for_url('**/pay/**')
      pg.click('button.choice.pay')
      pg.wait_for_url('**/order/**')
      shots.append(shot(pg))
      browser.close()

  # Three phones on one 1280-wide canvas, solid background (GitHub renders it in light and dark themes).
  gap, pad, width = 24, 32, 1280
  phone_w = (width - 2 * pad - 2 * gap) // 3
  phones = [s.resize((phone_w, round(s.height * phone_w / s.width)), Image.LANCZOS) for s in shots]
  height = max(ph.height for ph in phones) + 2 * pad
  canvas = Image.new('RGB', (width, height), (232, 230, 223))
  draw = ImageDraw.Draw(canvas)
  for i, ph in enumerate(phones):
      x = pad + i * (phone_w + gap)
      draw.rounded_rectangle((x - 2, pad - 2, x + phone_w + 1, pad + ph.height + 1), radius=18, outline=(200, 197, 188), width=2)
      mask = Image.new('L', ph.size, 0)
      ImageDraw.Draw(mask).rounded_rectangle((0, 0, ph.width - 1, ph.height - 1), radius=16, fill=255)
      canvas.paste(ph, (x, pad), mask)
  out.parent.mkdir(parents=True, exist_ok=True)
  canvas.save(out, optimize=True)
  size = out.stat().st_size
  print(f'{out} {canvas.width}x{canvas.height} {size // 1024} KB')
  return size < 1024 * 1024


ok = [render('/en', docs / 'demo.png'), render('', docs / 'demo.ms.png')]
sys.exit(0 if all(ok) else 1)
