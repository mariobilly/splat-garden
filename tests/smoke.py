"""Quick look at the running app in a real (GPU) Chrome: loads a source and screenshots every look.

    python tests/smoke.py [source image or video] [out folder]
Needs the server running (python app.py).
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:48331/"
SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "_out")
os.makedirs(OUT, exist_ok=True)

ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"]


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=ARGS)
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        logs = []
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
        pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
        pg.goto(URL)
        pg.wait_for_function("window.SG && document.querySelectorAll('.look').length === 5", timeout=20000)
        gpu = pg.evaluate("""() => { const gl = document.createElement('canvas').getContext('webgl2');
            const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }""")
        print("GPU:", gpu)
        if SRC:
            pg.set_input_files("#fileMedia", SRC)
        else:
            pg.click("#btnSample")
        pg.wait_for_function("window.SG.S.set && window.SG.R.orderCount === window.SG.S.set.count", timeout=180000)
        print("loaded:", pg.evaluate("JSON.stringify({m: SG.S.media && SG.S.media.name, n: SG.S.set.count})"))
        for i, look in enumerate(pg.evaluate("SG.S.looks.map(l => l.id)")):
            pg.evaluate(f"SG.applyLook('{look}')")
            pg.evaluate("SG.S.playing = false; SG.S.time = SG.S.P.duration * 0.3; SG.S.dirty = true;")
            time.sleep(0.8)
            pg.screenshot(path=os.path.join(OUT, f"ui-{i + 1}-{look}.png"))
        print("\n".join(logs[-30:]))
        b.close()


if __name__ == "__main__":
    main()
