#!/usr/bin/env python3
"""demo-assets.py: the hosted demo's tab icons and link-preview cards, written to examples/demo/assets/.

    python3 scripts/demo-assets.py            # (re)generate and write the assets
    python3 scripts/demo-assets.py --check    # generate into a temporary folder; exit 1 if any committed file differs

Inputs, nothing else: brand/logo.svg (the icon), the demo's own fonts (examples/demo/fonts/), the light palette of
examples/demo/demo.css, and the og.* text of examples/demo/i18n/{ms,en}.json (one card per language). Change the text
in i18n and run this again; no words or colours live in this script.

Outputs: favicon.svg, favicon.ico (16, 32 and 48 px PNGs inside one ICO), apple-touch-icon.png (180 px, full bleed,
because iOS masks the corners itself), og-ms.png and og-en.png (1200x630). Rendered with Playwright Chromium, the
same way as brand/jana-aset.py. --check is not part of `npm run gate` because CI has no browser.
"""
import base64
import hashlib
import html
import json
import re
import struct
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "examples" / "demo"
OUT = DEMO / "assets"
CARD = (1200, 630)
ICO_SIZES = (16, 32, 48)
TOUCH = 180
LANGS = ("ms", "en")


def palette():
    """The light half of every light-dark() token in demo.css: the card is the page as most visitors first see it."""
    css = (DEMO / "demo.css").read_text("utf-8")
    return {m[0]: m[1] for m in re.findall(r"--([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),", css)}


def font_face(family, file, weight):
    data = base64.b64encode((DEMO / "fonts" / file).read_bytes()).decode()
    return f'@font-face{{font-family:"{family}";src:url(data:font/woff2;base64,{data}) format("woff2");font-weight:{weight}}}'


def logo():
    return (ROOT / "brand" / "logo.svg").read_text("utf-8")


def favicon_svg():
    """brand/logo.svg without its fixed size (the browser sizes a favicon) and without comments; the title stays."""
    svg = logo()
    root = svg[: svg.index(">") + 1]
    svg = re.sub(r'\s(width|height)="[^"]*"', "", root) + svg[len(root):]
    svg = re.sub(r"\s*<!--.*?-->", "", svg, flags=re.S)
    return re.sub(r">\s+<", "><", svg).strip() + "\n"


def touch_svg():
    """The ink tile cropped to its edges with square corners: iOS rounds the corners of a touch icon itself."""
    svg = logo().replace('viewBox="0 0 256 256"', 'viewBox="16 16 224 224"').replace('rx="56"', 'rx="0"')
    return re.sub(r'\s*<rect x="17"[^>]*/>', "", svg)


# The receipt's torn bottom edge: a row of small teeth, the same as the slip in the demo's header mark.
def teeth(width, tooth=24, depth=12):
    pts = [f"{x},{0 if (x // tooth) % 2 == 0 else depth}" for x in range(0, width + 1, tooth)]
    return f'<svg class="teeth" width="{width}" height="{depth}" viewBox="0 0 {width} {depth}"><polygon points="0,0 {" ".join(pts)} {width},0"/></svg>'


def card_html(og, c):
    w, h = CARD
    esc = html.escape
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
{font_face("Schibsted Grotesk", "schibsted-grotesk.woff2", "400 900")}
{font_face("JetBrains Mono", "jetbrains-mono.woff2", "500")}
*{{margin:0;box-sizing:border-box}}
html,body{{width:{w}px;height:{h}px;overflow:hidden}}
body{{background:{c["paper"]};color:{c["ink"]};font-family:"Schibsted Grotesk",sans-serif;display:grid;place-items:center}}
.lines{{position:absolute;left:0;top:0}}
.lines path{{fill:none;stroke:{c["rule-strong"]};stroke-width:10;stroke-linecap:round}}
.lines circle{{fill:{c["rule-strong"]}}}
.slip{{position:relative;width:600px;margin-top:6px;filter:drop-shadow(0 22px 26px rgb(20 32 26 / .16))}}
.paper{{background:{c["sheet"]};padding:40px 48px 34px;border-top:6px solid {c["green"]}}}
.teeth{{display:block}}
.teeth polygon{{fill:{c["sheet"]}}}
.brand{{display:flex;align-items:center;gap:14px}}
.brand svg{{width:58px;height:58px;margin:-4px}}
.word{{font-weight:650;font-size:38px;letter-spacing:-.025em}}
.tag{{font:500 15px/1 "JetBrains Mono",monospace;letter-spacing:.06em;text-transform:uppercase;color:{c["ink-2"]};
 border:1.5px solid {c["rule-strong"]};border-radius:5px;padding:5px 7px 4px;margin-left:4px}}
h1{{font-weight:750;font-size:52px;line-height:1.04;letter-spacing:-.03em;margin:34px 0 30px;text-wrap:balance}}
.foot{{display:flex;align-items:center;gap:14px;border-top:2px dashed {c["rule"]};padding-top:24px;
 font-size:23px;line-height:1.25;color:{c["ink-2"]};text-wrap:balance}}
.ok{{flex:none;width:40px;height:40px;border-radius:50%;background:{c["green"]};display:grid;place-items:center}}
.ok path{{fill:none;stroke:{c["on-green"]};stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}}
</style></head><body>
<svg class="lines" width="{w}" height="{h}" viewBox="0 0 {w} {h}" aria-hidden="true">
 <path d="M-20 165 C160 165 170 315 300 315"/><path d="M-20 315 H300"/><path d="M-20 465 C160 465 170 315 300 315"/>
 <circle cx="88" cy="168" r="15"/><circle cx="88" cy="315" r="15"/><circle cx="88" cy="462" r="15"/>
</svg>
<div class="slip"><div class="paper">
 <div class="brand">{logo()}<span class="word">bayarkit</span><span class="tag">demo</span></div>
 <h1>{esc(og["headline"])}</h1>
 <p class="foot"><span class="ok"><svg width="22" height="22" viewBox="0 0 22 22"><path d="M4.5 11.5l4.5 4.5 8.5-9"/></svg></span>{esc(og["kicker"])}</p>
</div>{teeth(600)}</div>
</body></html>"""


def png_size(b):
    return struct.unpack(">II", b[16:24])


def ico(pngs):
    """An ICO that holds PNG images (supported by every browser since IE Vista), written by hand: 6-byte header,
    one 16-byte directory entry per image, then the PNGs."""
    head = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, body = b"", b""
    for p in pngs:
        w, h = png_size(p)
        entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(p), offset + len(body))
        body += p
    return head + entries + body


def render(out):
    out.mkdir(parents=True, exist_ok=True)
    colours = palette()
    (out / "favicon.svg").write_text(favicon_svg(), "utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()

        def snap(markup, size, transparent):
            pg = b.new_page(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
            pg.set_content(markup)
            pg.evaluate("document.fonts.ready")
            shot = pg.screenshot(omit_background=transparent)
            pg.close()
            return shot

        def icon(svg, size, transparent=True):
            # Size the root <svg> only: the tile <rect> inside has width/height of its own.
            root = svg[: svg.index(">") + 1]
            sized = re.sub(r'\s(width|height)="\d+"', "", root).replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
            inner = sized + svg[len(root):]
            return snap(f'<html><body style="margin:0;background:transparent">{inner}</body></html>', (size, size), transparent)

        (out / "favicon.ico").write_bytes(ico([icon(favicon_svg(), s) for s in ICO_SIZES]))
        (out / "apple-touch-icon.png").write_bytes(icon(touch_svg(), TOUCH, transparent=False))
        for lang in LANGS:
            og = json.loads((DEMO / "i18n" / f"{lang}.json").read_text("utf-8"))["og"]
            (out / f"og-{lang}.png").write_bytes(snap(card_html(og, colours), CARD, False))
        b.close()


NAMES = ("favicon.svg", "favicon.ico", "apple-touch-icon.png", "og-ms.png", "og-en.png")


def main():
    if "--check" in sys.argv[1:]:
        with tempfile.TemporaryDirectory() as tmp:
            render(Path(tmp))
            stale = [n for n in NAMES if not (OUT / n).exists()
                     or hashlib.sha256((OUT / n).read_bytes()).digest() != hashlib.sha256((Path(tmp) / n).read_bytes()).digest()]
        for n in stale:
            print(f"examples/demo/assets/{n} is out of date: run python3 scripts/demo-assets.py")
        sys.exit(1 if stale else 0)
    render(OUT)
    for n in NAMES:
        f = OUT / n
        extra = "x".join(map(str, png_size(f.read_bytes()))) if n.endswith(".png") else ""
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size} bytes  {extra}")


if __name__ == "__main__":
    main()
