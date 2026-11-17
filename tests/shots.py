"""Render canvas-only shots of the running app for a list of setups (debugging and the test report).

    python tests/shots.py setups.json out_folder
setups.json: [{"name": "...", "source": "path or null (keep current)", "look": "drip-pot", "params": {...},
               "t": 0.3 (fraction of the clip), "user": {"yaw": 0, "pitch": 0, "zoom": 1}}]
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = os.environ.get("SG_URL", "http://127.0.0.1:48331/")
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]


class _Chrome:
    """Our own headless Chrome over CDP. Playwright's browser.close() can hang for minutes on some PCs (GPU process
    shutdown), so we start Chrome ourselves and kill the process tree when done."""

    def __init__(self, p, width, height):
        import socket
        import subprocess
        import tempfile
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        exe = p.chromium.executable_path
        for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
            if os.path.exists(c):
                exe = c
                break
        self.profile = tempfile.mkdtemp(prefix="sg-test-")
        self.proc = subprocess.Popen([exe, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={self.profile}",
                                      "--no-first-run", "--no-default-browser-check", f"--window-size={width},{height}"] + ARGS + ["about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self.b = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                break
            except Exception:
                time.sleep(0.2)

    def new_page(self, **kw):
        ctx = self.b.contexts[0]
        pg = ctx.new_page()
        if kw.get("viewport"):
            pg.set_viewport_size(kw["viewport"])
        return pg

    def close(self):
        # Chrome hands over to a fresh browser process at start, so kill everything that uses our profile folder
        import shutil
        import psutil
        try:
            self.b.close()
        except Exception:
            pass
        for _ in range(3):
            procs = []
            for pr in psutil.process_iter(["name", "cmdline"]):
                try:
                    if (pr.info["name"] or "").lower() == "chrome.exe" and self.profile in " ".join(pr.info["cmdline"] or []):
                        procs.append(pr)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            if not procs:
                break
            for pr in procs:
                try:
                    pr.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            psutil.wait_procs(procs, timeout=5)
        shutil.rmtree(self.profile, ignore_errors=True)


def open_page(p, width=1500, height=950):
    b = _Chrome(p, width, height)
    pg = b.new_page(viewport={"width": width, "height": height})
    pg.logs = []
    pg.on("console", lambda m: pg.logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: pg.logs.append(f"pageerror: {e}"))
    pg.goto(URL, wait_until="domcontentloaded", timeout=90000)
    pg.wait_for_function("window.SG && document.querySelectorAll('.look').length >= 5", timeout=90000)
    return b, pg


def load_source(pg, src):
    pg.evaluate("SG.S.set = null")
    if src.lower().endswith((".ply", ".splat")):
        pg.set_input_files("#fileScan", src)
    else:
        pg.set_input_files("#fileMedia", src)
    pg.wait_for_function("window.SG.S.set && window.SG.R.orderCount === window.SG.S.set.count", timeout=300000)


def render(pg, setup, path, size=1080):
    if setup.get("look"):
        pg.evaluate(f"SG.applyLook({json.dumps(setup['look'])})")
    for k, v in (setup.get("params") or {}).items():
        pg.evaluate(f"SG.setParam({json.dumps(k)}, {json.dumps(v)})")
    if "aspect" in setup:
        pg.evaluate(f"SG.S.aspect = {json.dumps(setup['aspect'])}")
    pg.evaluate(f"SG.S.user = {json.dumps(setup.get('user') or {'yaw': 0, 'pitch': 0, 'zoom': 1})}; SG.S.playing = false;")
    t = float(setup.get("t", 0.3))
    data_url = pg.evaluate("""async (t) => {
        const S = SG.S, [w, h] = {'1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '16:9': [1920, 1080]}[S.aspect];
        S.time = t * S.P.duration;
        await SG.renderAt(S.time, w, h);
        const px = SG.R.readPixels(w, h);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        ctx.putImageData(img, 0, 0);
        S.builtIdx = -1; S.dirty = true;
        return cv.toDataURL('image/jpeg', 0.9);
    }""", t)
    import base64
    with open(path, "wb") as f:
        f.write(base64.b64decode(data_url.split(",", 1)[1]))


def main():
    setups = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    T0 = time.time()
    with sync_playwright() as p:
        b, pg = open_page(p)
        print(f"page ready {time.time() - T0:.1f}s")
        cur = None
        for s in setups:
            if s.get("source") and s["source"] != cur:
                t0 = time.time()
                load_source(pg, s["source"])
                cur = s["source"]
                print(f"loaded {os.path.basename(cur)} in {time.time() - t0:.1f}s, {pg.evaluate('SG.S.set.count')} splats")
            t1 = time.time()
            render(pg, s, os.path.join(out, s["name"] + ".jpg"))
            print(f"shot {s['name']} {time.time() - t1:.1f}s")
        errs = [l for l in pg.logs if "error" in l.lower() and "favicon" not in l and "icon.png" not in l]
        if errs:
            print("\n".join(errs[-20:]))
        b.close()
    print(f"total {time.time() - T0:.1f}s")


if __name__ == "__main__":
    main()
