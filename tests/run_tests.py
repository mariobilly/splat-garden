"""Runs every Splat Garden check and writes tests\\_out\\report.html.

    python tests/run_tests.py

Starts its own server on port 48339, with renders going to tests\\_out (or SPLAT_GARDEN_TEST_OUT), and stops it at
the end. Needs Chrome, ffmpeg and a GPU. The test sources are in tests\\sources (public-domain and CC0 files,
credited in tests\\sources\\CREDITS.md and in the report).
"""
import base64
import html
import json
import os
import re
import struct
import subprocess
import sys
import time
import traceback
import urllib.request

import numpy as np

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.environ.get("SPLAT_GARDEN_TEST_OUT") or os.path.join(APP, "tests", "_out")
SOURCES = os.path.join(APP, "tests", "sources")
RENDERS = os.path.join(TESTS, "renders")
COMPARE = os.path.join(TESTS, "compare")
SCREENS = os.path.join(TESTS, "screens")
PORT = 48339
BASE = f"http://127.0.0.1:{PORT}"
os.environ["SG_URL"] = BASE + "/"
sys.path.insert(0, APP)
sys.path.insert(0, os.path.join(APP, "tests"))

import media  # noqa: E402
from shots import open_page, render  # noqa: E402

LOOKS = [  # look, test source, clip time
    ("drip-pot", os.path.join(APP, "sample", "geranium-pot.jpg"), 0.3),
    ("ember", os.path.join(SOURCES, "portrait-antonello.jpg"), 0.3),
    ("bubble", os.path.join(SOURCES, "nasturtium-plant.jpg"), 0.3),
    ("felt", os.path.join(SOURCES, "portrait-velazquez.jpg"), 0.5),
    ("swirl", os.path.join(SOURCES, "bee-balm-clip.mp4"), 0.8),
]
CREDITS = [
    ("geranium-pot.jpg (sample)", "Pot with geranium.jpg by Kattusa24, Wikimedia Commons, public domain"),
    ("portrait-antonello.jpg", "Portrait of a Young Man, Antonello da Messina, The Metropolitan Museum of Art, CC0"),
    ("nasturtium-plant.jpg", "Tropaeolum majus 2005 G1.jpg by George Chernilevsky, Wikimedia Commons, public domain"),
    ("portrait-velazquez.jpg", "Portrait of a Man, Velazquez, The Metropolitan Museum of Art, CC0"),
    ("bee-balm-clip.mp4", "Flowers (20210630-FPAC-KLS-0001).webm, USDA, public domain (9 s cut)"),
]
RESULTS = []


def check(group, name):
    def deco(fn):
        t0 = time.time()
        try:
            detail = fn() or ""
            RESULTS.append((group, name, True, str(detail), time.time() - t0))
            print(f"PASS {group}: {name} {detail}", flush=True)
        except Exception as e:
            RESULTS.append((group, name, False, f"{type(e).__name__}: {e}", time.time() - t0))
            print(f"FAIL {group}: {name}: {e}", flush=True)
            traceback.print_exc()
        return fn
    return deco


def get(path, raw=False, timeout=60):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        data = r.read()
    return data if raw else json.loads(data)


def post(path, body=None, raw=None, timeout=120):
    data = raw if raw is not None else json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST",
                                 headers={"Content-Type": "application/octet-stream" if raw is not None else "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def wait_job(job, timeout=600):
    t0 = time.time()
    while job["state"] not in ("done", "error"):
        if time.time() - t0 > timeout:
            raise TimeoutError("import took too long")
        time.sleep(0.5)
        job = get("/api/job/" + job["id"])
    if job["state"] == "error":
        raise RuntimeError(job["error"])
    return job["meta"]


def ffprobe(path):
    out = subprocess.run([media.ffprobe_exe(), "-v", "error", "-count_frames", "-print_format", "json", "-show_streams", "-show_format", path],
                         capture_output=True, timeout=120)
    return json.loads(out.stdout)


def upload(path, detail):
    import uuid
    b = uuid.uuid4().hex
    name = os.path.basename(path)
    with open(path, "rb") as f:
        content = f.read()
    parts = [f"--{b}\r\nContent-Disposition: form-data; name=\"detail\"\r\n\r\n{detail}\r\n".encode(),
             f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode(),
             content, f"\r\n--{b}--\r\n".encode()]
    req = urllib.request.Request(BASE + "/api/import", data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def ply_to_splat(ply, out):
    """Write the antimatter15 .splat layout from a 3DGS .ply (to test the .splat reader)."""
    raw = open(ply, "rb").read()
    end = raw.index(b"end_header\n") + 11
    props = [l.split()[-1] for l in raw[:end].decode().splitlines() if l.startswith("property")]
    a = np.frombuffer(raw[end:], np.float32).reshape(-1, len(props))
    d = {k: a[:, i] for i, k in enumerate(props)}
    n = len(a)
    rec = np.zeros(n, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("q", "u1", 4)])
    rec["p"] = np.stack([d["x"], d["y"], d["z"]], 1)
    rec["s"] = np.exp(np.stack([d["scale_0"], d["scale_1"], d["scale_2"]], 1))
    col = 0.5 + 0.28209479177387814 * np.stack([d["f_dc_0"], d["f_dc_1"], d["f_dc_2"]], 1)
    alpha = 1 / (1 + np.exp(-d["opacity"]))
    rec["c"] = np.clip(np.concatenate([col, alpha[:, None]], 1) * 255, 0, 255).astype(np.uint8)
    q = np.stack([d["rot_0"], d["rot_1"], d["rot_2"], d["rot_3"]], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    rec["q"] = np.clip(q * 128 + 128, 0, 255).astype(np.uint8)
    rec.tofile(out)
    return n


def img_from_data_url(u):
    from PIL import Image
    import io
    return Image.open(io.BytesIO(base64.b64decode(u.split(",", 1)[1]))).convert("RGB")


def main():
    for d in (TESTS, RENDERS, COMPARE, SCREENS):
        os.makedirs(d, exist_ok=True)
    for d in (RENDERS, COMPARE, SCREENS):  # outputs of the previous run
        for f in os.listdir(d):
            if os.path.isfile(os.path.join(d, f)) and not f.startswith("0-"):  # 0-*: the real launch, captured by hand
                os.remove(os.path.join(d, f))
    env = dict(os.environ, SPLAT_GARDEN_PORT=str(PORT), SPLAT_GARDEN_OUT=RENDERS)
    server = subprocess.Popen([sys.executable, os.path.join(APP, "app.py")], cwd=APP, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    try:
        for _ in range(100):
            try:
                if get("/api/ping")["app"] == "splat-garden":
                    break
            except Exception:
                time.sleep(0.3)
        run_all()
    finally:
        import psutil
        try:
            pr = psutil.Process(server.pid)
            for c in pr.children(recursive=True):
                c.kill()
            pr.kill()
        except psutil.NoSuchProcess:
            pass
    write_report(time.time() - t0)
    bad = [r for r in RESULTS if not r[2]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} checks passed. Report: {os.path.join(TESTS, 'report.html')}")
    return 1 if bad else 0


def run_all():
    G = "Python"

    @check(G, "file kinds")
    def _():
        assert media.kind_of("a.JPG") == "image" and media.kind_of("b.mov") == "video" and media.kind_of("c.ply") == "scan"
        assert media.kind_of("d.txt") is None

    @check(G, "default output folder is Videos\\Splat Garden")
    def _():
        import shutil
        import tempfile
        home = tempfile.mkdtemp(prefix="sg-home-")  # a stand-in user folder, so the real Videos folder is not touched
        old = os.environ.pop("SPLAT_GARDEN_OUT", None)
        old_home = {k: os.environ.get(k) for k in ("USERPROFILE", "HOME")}
        os.environ["USERPROFILE"] = os.environ["HOME"] = home
        try:
            p = media.output_dir()
        finally:
            for k, v in old_home.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            if old:
                os.environ["SPLAT_GARDEN_OUT"] = old
        want = os.path.join(home, "Videos", "Splat Garden")
        ok = os.path.normcase(p) == os.path.normcase(want) and os.path.isdir(p)
        shutil.rmtree(home, ignore_errors=True)
        assert ok, p
        return "Videos\\Splat Garden in the user folder"

    @check(G, "unique output names")
    def _():
        p1 = media.unique_path(RENDERS, "name:with/bad*chars", ".txt")
        assert os.path.basename(p1) == "name_with_bad_chars.txt", p1

    @check(G, "probe the test video")
    def _():
        i = media.probe(os.path.join(SOURCES, "bee-balm-clip.mp4"))
        assert i["width"] == 1280 and i["height"] == 720 and i["has_audio"] and 8.9 < i["duration"] < 9.1, i
        return f"{i['width']}x{i['height']}, {i['duration']:.1f}s, audio"

    G = "Server"

    @check(G, "ping, presets, info")
    def _():
        assert get("/api/ping")["app"] == "splat-garden"
        looks = get("/api/presets")["looks"]
        assert [l["id"] for l in looks] == [l[0] for l in LOOKS]
        keys = set(re.findall(r"\{ k: '(\w+)'", open(os.path.join(APP, "static", "app.js"), encoding="utf-8").read()))
        for l in looks:
            unknown = set(l["params"]) - keys
            assert not unknown, f"{l['id']} has unknown params {unknown}"
        assert os.path.normcase(get("/api/info")["output_dir"]) == os.path.normcase(RENDERS)
        return "5 looks, every preset key is a real control"

    meta = {}

    @check(G, "import a photo (depth + cut-out)")
    def _():
        t = time.time()
        m = wait_job(upload(LOOKS[0][1], 640))
        meta["photo"] = m
        raw = get(f"/api/media/{m['id']}/frame/0", raw=True)
        w, h = m["width"], m["height"]
        assert len(raw) == w * h * 6, len(raw)
        rgba = np.frombuffer(raw[:w * h * 4], np.uint8).reshape(h, w, 4)
        disp = np.frombuffer(raw[w * h * 4:], "<u2").reshape(h, w)
        cover = float((rgba[..., 3] > 128).mean())
        assert 0.03 < cover < 0.9, cover
        assert disp.min() < 2000 and disp.max() > 63000, (disp.min(), disp.max())
        return f"{w}x{h}, cut-out covers {cover:.0%}, {time.time() - t:.1f}s"

    @check(G, "import a video (24 fps, sound kept)")
    def _():
        t = time.time()
        m = wait_job(upload(LOOKS[4][1], 480))
        meta["video"] = m
        assert m["kind"] == "video" and m["frames"] == 216 and m["fps"] == 24 and m["has_audio"], m
        a = get(f"/api/media/{m['id']}/frame/10", raw=True)
        b = get(f"/api/media/{m['id']}/frame/200", raw=True)
        assert a != b
        return f"{m['width']}x{m['height']}, {m['frames']} frames, {time.time() - t:.1f}s (cached after the first run)"

    @check(G, "re-opening the same file uses the cache")
    def _():
        t = time.time()
        job = upload(LOOKS[0][1], 640)
        assert job["state"] == "done" and job["media"] == meta["photo"]["id"], job
        return f"{time.time() - t:.2f}s"

    @check(G, "reprocess at another detail")
    def _():
        m = wait_job(post("/api/reprocess", {"media": meta["photo"]["id"], "detail": 360}))
        assert max(m["width"], m["height"]) == 360 and m["id"] != meta["photo"]["id"], m
        return f"{m['width']}x{m['height']}"

    @check(G, "recent list and bad input")
    def _():
        ids = [m["id"] for m in get("/api/media")["items"]]
        assert meta["photo"]["id"] in ids and meta["video"]["id"] in ids
        try:
            post("/api/import-paths", {"paths": [os.path.join(APP, "README.md")]})
            r = get("/api/inbox")
            assert not r["jobs"] and not r["scans"]
        except urllib.error.HTTPError as e:
            raise AssertionError(e)
        try:
            get("/api/media/zzz")
            raise AssertionError("bad id accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 404

    # ------------------------------------------------------------ browser
    from playwright.sync_api import sync_playwright
    G = "App window"
    with sync_playwright() as p:
        b, pg = open_page(p, 1600, 980)
        try:
            browser_checks(G, pg, meta)
        finally:
            b.close()


def load_media(pg, m):
    pg.evaluate("async (id) => { const m = await (await fetch('/api/media/' + id)).json(); await SG.loadMedia(m); }", m["id"])
    pg.wait_for_function("SG.S.set && SG.R.orderCount === SG.S.set.count", timeout=60000)


def shot(pg, setup, path):
    render(pg, setup, path)
    from PIL import Image
    return np.asarray(Image.open(path).convert("RGB"), np.float32)


def browser_checks(G, pg, meta):
    import urllib.parse

    @check(G, "opens with the five looks on the GPU")
    def _():
        gpu = pg.evaluate("""() => { const gl = document.createElement('canvas').getContext('webgl2');
            const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }""")
        assert pg.locator(".look").count() == 5
        return gpu.split("(")[1].split(",")[1].strip() if "(" in gpu else gpu

    renders = {}

    @check(G, "every look renders on its test source and the five differ")
    def _():
        for look, src, ct in LOOKS:
            kind = media.kind_of(src)
            m = meta["video"] if kind == "video" else wait_job(upload(src, 640))
            load_media(pg, m)
            path = os.path.join(COMPARE, f"app-{look}.jpg")
            img = shot(pg, {"look": look, "t": ct}, path)
            bg = np.array([0, 53, 255], np.float32) if look in ("drip-pot", "ember", "bubble") else np.zeros(3, np.float32)
            content = float((np.abs(img - bg).sum(2) > 60).mean())
            assert content > 0.05, f"{look}: only {content:.1%} of the frame has content"
            renders[look] = img
        ks = list(renders)
        diffs = [float(np.abs(renders[ks[i]] - renders[ks[j]]).mean()) for i in range(5) for j in range(i + 1, 5)]
        assert min(diffs) > 10, diffs
        return f"smallest difference between two looks: {min(diffs):.0f}/255"

    @check(G, "same frame renders the same twice")
    def _():
        load_media(pg, meta["photo"])
        a = shot(pg, {"look": "drip-pot", "t": 0.42}, os.path.join(COMPARE, "_det-a.jpg"))
        c = shot(pg, {"look": "drip-pot", "t": 0.42}, os.path.join(COMPARE, "_det-b.jpg"))
        d = float(np.abs(a - c).mean())
        assert d < 1.0, d
        for f in ("_det-a.jpg", "_det-b.jpg"):
            os.remove(os.path.join(COMPARE, f))
        return f"mean difference {d:.2f}/255"

    @check(G, "every slider is wired (changing each one changes the picture)")
    def _():
        load_media(pg, meta["photo"])
        pg.evaluate("SG.applyLook('drip-pot')")
        base = shot(pg, {"t": 0.3}, os.path.join(COMPARE, "_s.jpg"))
        changes = {"relief": 0.8, "edge": 8, "fov": 90, "scale": 2.2, "opacity": 0.4, "jitter": 0.9, "fuzz": 0.9, "drip": 1.0,
                   "veil": 1.0, "floaters": 1.0, "smear": 1.0, "swirl": 4, "sphere": 1.0, "blocks": 1.0, "stretch": 1.0,
                   "amount": 60, "pitch": -30, "dolly": 0.6, "zoom": 2, "bg": "#ff00aa", "exposure": 1.8, "contrast": 1.8,
                   "saturation": 0.0, "blacks": 0.4, "lift": 0.4, "warmth": 1.0, "tintAmt": 1.0, "soften": 1.0, "glow": 1.0,
                   "grain": 0.3, "vignette": 1.0, "matte": "none", "cutoff": 0.9}
        dead = []
        for k, v in changes.items():
            pg.evaluate("SG.applyLook('drip-pot')")
            img = shot(pg, {"params": {k: v}, "t": 0.3}, os.path.join(COMPARE, "_s.jpg"))
            if float(np.abs(img - base).mean()) < 0.5:
                dead.append(k)
        os.remove(os.path.join(COMPARE, "_s.jpg"))
        assert not dead, f"no visible change from {dead}"
        return f"{len(changes)} controls checked"

    @check(G, "drag to look around, wheel to zoom, keys 1-5")
    def _():
        pg.evaluate("SG.applyLook('drip-pot'); SG.S.user = {yaw: 0, pitch: 0, zoom: 1};")
        box = pg.locator("#view").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx + 120, cy + 40, steps=6); pg.mouse.up()
        pg.mouse.wheel(0, -300)
        u = pg.evaluate("SG.S.user")
        assert abs(u["yaw"]) > 0.3 and u["zoom"] > 1.2, u
        pg.keyboard.press("3")
        assert pg.evaluate("SG.S.look") == "bubble"
        pg.keyboard.press("r")
        assert pg.evaluate("SG.S.user.yaw") == 0
        return f"yaw {u['yaw']:.2f} rad, zoom {u['zoom']:.2f}"

    @check(G, "live preview speed while a video plays")
    def _():
        load_media(pg, meta["video"])
        pg.evaluate("SG.applyLook('swirl')")
        fps = pg.evaluate("""async () => { SG.S.playing = true; let n = 0; const a = performance.now(), i0 = SG.S.builtIdx;
            await new Promise(r => { const f = () => { n++; if (performance.now() - a < 3000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
            SG.S.playing = false; return n / 3; }""")
        assert fps >= 20, fps
        return f"{fps:.0f} fps"

    @check(G, "screenshots of the window, one per look")
    def _():
        for i, (look, src, *_r) in enumerate(LOOKS):
            m = meta["video"] if media.kind_of(src) == "video" else wait_job(upload(src, 640))
            load_media(pg, m)
            pg.evaluate(f"SG.applyLook('{look}'); SG.S.playing = false; SG.S.time = SG.S.P.duration * 0.3; SG.S.dirty = true;")
            pg.wait_for_timeout(700)
            pg.screenshot(path=os.path.join(SCREENS, f"{i + 1}-{look}.png"))
        return "screens\\"

    exported = {}

    @check(G, "export MP4 from a photo (Drip Pot, 5 s, 1:1)")
    def _():
        load_media(pg, meta["photo"])
        pg.evaluate("SG.applyLook('drip-pot'); SG.setParam('duration', 5); SG.S.aspect = '1:1'; SG.S.lastExport = null;")
        pg.evaluate("SG.exportMp4()")
        pg.wait_for_function("SG.S.exporting === false && SG.S.lastExport", timeout=600000, polling=500)
        r = pg.evaluate("SG.S.lastExport"); st = pg.evaluate("SG.S.lastExportStats")
        pr = ffprobe(r["path"])
        v = pr["streams"][0]
        assert v["width"] == 1080 and v["height"] == 1080 and int(v["nb_read_frames"]) == 120, v
        exported["photo"] = r["path"]
        return f"{os.path.basename(r['path'])}, {st['seconds']:.1f}s to render"

    @check(G, "export MP4 from a video with its sound (Swirl, 5 s, 9:16)")
    def _():
        load_media(pg, meta["video"])
        pg.evaluate("SG.applyLook('swirl'); SG.setParam('duration', 5); SG.S.aspect = '9:16'; SG.S.lastExport = null;")
        pg.evaluate("SG.exportMp4()")
        pg.wait_for_function("SG.S.exporting === false && SG.S.lastExport", timeout=600000, polling=500)
        r = pg.evaluate("SG.S.lastExport"); st = pg.evaluate("SG.S.lastExportStats")
        pr = ffprobe(r["path"])
        types = [s["codec_type"] for s in pr["streams"]]
        v = next(s for s in pr["streams"] if s["codec_type"] == "video")
        assert "audio" in types and v["width"] == 1080 and v["height"] == 1920 and int(v["nb_read_frames"]) == 120, pr
        assert abs(float(pr["format"]["duration"]) - 5.0) < 0.1
        exported["video"] = r["path"]
        pg.evaluate("SG.S.aspect = '1:1'")
        return f"{os.path.basename(r['path'])}, {st['seconds']:.1f}s to render"

    @check(G, "export the other three looks (12.5 s / 5 s clips)")
    def _():
        out = []
        for look, src, *_r in LOOKS[1:4]:
            m = wait_job(upload(src, 640))
            load_media(pg, m)
            pg.evaluate(f"SG.applyLook('{look}'); SG.S.aspect = '1:1'; SG.S.lastExport = null;")
            pg.evaluate("SG.exportMp4()")
            pg.wait_for_function("SG.S.exporting === false && SG.S.lastExport", timeout=900000, polling=500)
            r = pg.evaluate("SG.S.lastExport")
            dur = float(ffprobe(r["path"])["format"]["duration"])
            want = pg.evaluate("SG.S.P.duration")
            assert abs(dur - want) < 0.1, (dur, want)
            exported[look] = r["path"]
            out.append(f"{look} {dur:.1f}s")
        return ", ".join(out)

    @check(G, "save PNG and .ply, reopen the .ply and a .splat as scans")
    def _():
        load_media(pg, meta["photo"])
        pg.evaluate("SG.applyLook('drip-pot')")
        pg.evaluate("SG.savePng()")
        pg.evaluate("SG.savePly()")
        pngs = sorted((f for f in os.listdir(RENDERS) if f.endswith(".png")), key=lambda f: os.path.getmtime(os.path.join(RENDERS, f)))
        plys = sorted((f for f in os.listdir(RENDERS) if f.endswith(".ply")), key=lambda f: os.path.getmtime(os.path.join(RENDERS, f)))
        from PIL import Image
        assert Image.open(os.path.join(RENDERS, pngs[-1])).size == (1080, 1080)
        ply = os.path.join(RENDERS, plys[-1])
        raw = open(ply, "rb").read()
        n = int(re.search(rb"element vertex (\d+)", raw).group(1))
        sp = os.path.join(RENDERS, "roundtrip-test.splat")
        assert ply_to_splat(ply, sp) == n
        for path in (ply, sp):
            pg.evaluate("SG.S.scanName = null")
            post("/api/import-paths", {"paths": [path]})
            pg.wait_for_function(f"SG.S.scanName === {json.dumps(os.path.basename(path))} && SG.R.orderCount === SG.S.set.count", timeout=60000)
            assert pg.evaluate("SG.S.set.count") == n
        img = shot(pg, {"look": "drip-pot", "params": {"drip": 0, "stretch": 0, "floaters": 0}, "t": 0.2}, os.path.join(COMPARE, "scan-roundtrip.jpg"))
        assert float((np.abs(img - np.array([0, 53, 255])).sum(2) > 60).mean()) > 0.05
        return f"{n:,} splats both ways"

    def grab(t):
        """The app's own render of time t at 1080x1080 (current format), as a top-down float RGBA array."""
        raw = pg.evaluate("""async (t) => { await SG.renderAt(t, 1080, 1080); const px = SG.R.readPixels(1080, 1080);
            SG.S.builtIdx = -1; SG.S.dirty = true;
            let s = ''; for (let i = 0; i < px.length; i += 32768) s += String.fromCharCode.apply(null, px.subarray(i, i + 32768));
            return btoa(s); }""", t)
        return np.frombuffer(base64.b64decode(raw), np.uint8).reshape(1080, 1080, 4)[::-1].astype(np.float32)

    def decode(path, t, w, h):
        raw = subprocess.run([media.ffmpeg_exe(), "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1", "-f", "rawvideo",
                              "-pix_fmt", "rgba64le", "pipe:1"], capture_output=True, timeout=120).stdout
        return np.frombuffer(raw, "<u2").reshape(h, w, 4).astype(np.float32) / 65535.0

    def export_prores(look, secs, aspect):
        pg.evaluate(f"SG.applyLook('{look}'); SG.setParam('duration', {secs}); SG.S.aspect = '{aspect}'; SG.setFormat('prores'); SG.S.lastExport = null;")
        pg.evaluate("SG.exportMp4()")
        pg.wait_for_function("SG.S.exporting === false && SG.S.lastExport", timeout=600000, polling=500)
        return pg.evaluate("SG.S.lastExport"), pg.evaluate("SG.S.lastExportStats")

    @check(G, "export ProRes 4444 with a transparent background (photo, Drip Pot, 5 s)")
    def _():
        load_media(pg, meta["photo"])
        r, st = export_prores("drip-pot", 5, "1:1")
        pr = ffprobe(r["path"])
        v = pr["streams"][0]
        assert r["path"].endswith(".mov") and v["codec_name"] == "prores" and v.get("profile") == "4444", v
        assert v["pix_fmt"].startswith("yuva") and int(v["nb_read_frames"]) == 120, v
        f = decode(r["path"], 2.5, 1080, 1080)
        a = f[..., 3:4]
        clear, solid = float((a < 0.01).mean()), float((a > 0.99).mean())
        assert clear > 0.1 and solid > 0.05, (clear, solid)
        pg.evaluate("SG.setFormat('mp4')")
        opaque = grab(2.5)[..., :3]
        blue = np.array([0, 53, 255], np.float32)
        over = f[..., :3] * 255 * a + blue * (1 - a)
        diff = float(np.abs(over - opaque).mean())
        assert diff < 2.0, diff
        return (f"{os.path.basename(r['path'])}, {os.path.getsize(r['path']) / 1e6:.0f} MB, {clear:.0%} fully transparent; "
                f"laid over the blue it matches the normal render within {diff:.2f}/255")

    @check(G, "export ProRes 4444 from a video keeps the sound (Drip Pot cut-out, 3 s, 9:16)")
    def _():
        load_media(pg, meta["video"])
        r, st = export_prores("drip-pot", 3, "9:16")
        pr = ffprobe(r["path"])
        v = next(s for s in pr["streams"] if s["codec_type"] == "video")
        au = [s for s in pr["streams"] if s["codec_type"] == "audio"]
        assert v["width"] == 1080 and v["height"] == 1920 and v["pix_fmt"].startswith("yuva") and int(v["nb_read_frames"]) == 72, v
        assert au and au[0]["codec_name"] == "pcm_s16le", au
        a = decode(r["path"], 1.5, 1080, 1920)[..., 3]
        assert float((a < 0.01).mean()) > 0.1
        pg.evaluate("SG.setFormat('mp4'); SG.S.aspect = '1:1';")
        return f"{os.path.basename(r['path'])}, {os.path.getsize(r['path']) / 1e6:.0f} MB, PCM sound"

    @check(G, "Save PNG keeps the transparency in ProRes mode")
    def _():
        load_media(pg, meta["photo"])
        pg.evaluate("SG.applyLook('drip-pot'); SG.setFormat('prores'); SG.S.time = 1.0;")
        before = set(os.listdir(RENDERS))
        pg.evaluate("SG.savePng()")
        new = [f for f in set(os.listdir(RENDERS)) - before if f.endswith(".png")]
        pg.evaluate("SG.setFormat('mp4')")
        from PIL import Image
        im = Image.open(os.path.join(RENDERS, new[0]))
        a = np.asarray(im.convert("RGBA"))[..., 3]
        assert im.mode == "RGBA" and a.min() == 0 and a.max() == 255, (im.mode, a.min(), a.max())
        return f"{new[0]}: {float((a == 0).mean()):.0%} transparent"

    errs = [l for l in pg.logs if ("error" in l.lower() or "pageerror" in l) and "icon.png" not in l]

    @check(G, "no errors in the page console")
    def _():
        assert not errs, errs[:5]


def write_report(seconds):
    from PIL import Image
    ok = sum(1 for r in RESULTS if r[2])
    rows = "\n".join(f"<tr class='{'ok' if r[2] else 'bad'}'><td>{'PASS' if r[2] else 'FAIL'}</td><td>{html.escape(r[0])}</td>"
                     f"<td>{html.escape(r[1])}</td><td>{html.escape(r[3])}</td><td>{r[4]:.1f}s</td></tr>" for r in RESULTS)
    looks = "\n".join(f"<figure><img src='compare/app-{l}.jpg'><figcaption><b>{l}</b> on <i>{html.escape(os.path.basename(s))}</i>"
                      f"</figcaption></figure>" for l, s, *_ in LOOKS if os.path.exists(os.path.join(COMPARE, f"app-{l}.jpg")))
    vids = "\n".join(f"<li><a href='renders/{html.escape(f)}'>{html.escape(f)}</a> ({os.path.getsize(os.path.join(RENDERS, f)) / 1e6:.1f} MB)</li>"
                     for f in sorted(os.listdir(RENDERS)) if f.endswith((".mp4", ".mov", ".png", ".ply")))
    screens = "\n".join(f"<img class='screen' src='screens/{f}'>" for f in sorted(os.listdir(SCREENS)) if f.endswith(".png"))
    credits = "\n".join(f"<li><b>{html.escape(a)}</b>: {html.escape(b)}</li>" for a, b in CREDITS)
    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Splat Garden tests</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root {{ --bg:#0b0d12; --fg:#e8ecf4; --dim:#8a93a6; --ok:#7dff8a; --bad:#ff6a6a; --line:#232a36; }}
body {{ background:var(--bg); color:var(--fg); font:14px/1.5 "Segoe UI",system-ui,sans-serif; margin:0; padding:24px 28px 60px; }}
h1 {{ margin:0 0 4px; }} h2 {{ margin:34px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px; }}
.sum {{ color:var(--dim); }} table {{ border-collapse:collapse; width:100%; }} td {{ padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }}
tr.ok td:first-child {{ color:var(--ok); font-weight:700; }} tr.bad td:first-child {{ color:var(--bad); font-weight:700; }}
figure {{ margin:0 0 18px; }} figure img {{ width:100%; max-width:1080px; display:block; border-radius:6px; }}
figcaption {{ color:var(--dim); margin-top:4px; }} .screen {{ width:100%; max-width:1200px; display:block; margin:0 0 14px; border-radius:6px; border:1px solid var(--line); }}
a {{ color:#8fb0ff; }}
</style></head><body>
<h1>Splat Garden: test report</h1>
<div class="sum">{ok}/{len(RESULTS)} checks passed · {time.strftime('%Y-%m-%d %H:%M')} · {seconds:.0f}s</div>
<h2>Checks</h2><table>{rows}</table>
<h2>The five looks</h2>{looks}
<h2>Renders made by the tests</h2><ul>{vids}</ul>
<h2>The app window</h2>{screens}
<h2>Test sources</h2><ul>{credits}</ul>
</body></html>"""
    with open(os.path.join(TESTS, "report.html"), "w", encoding="utf-8") as f:
        f.write(doc)
    with open(os.path.join(TESTS, "results.json"), "w", encoding="utf-8") as f:
        json.dump([{"group": g, "name": n, "ok": o, "detail": d, "seconds": round(s, 2)} for g, n, o, d, s in RESULTS], f, indent=1)


if __name__ == "__main__":
    sys.exit(main())
