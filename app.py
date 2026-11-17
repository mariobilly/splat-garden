"""Splat Garden server: processes sources into depth + cut-out frames and turns rendered frames into MP4s.

The app window (static/) does the actual splat rendering in WebGL2. This server only:
  - runs imports through the GPU worker (splat.py) and caches the result per source file;
  - streams the cached frames to the window;
  - pipes exported frames into ffmpeg (media.Encoder) and saves PNG stills and .ply scans.
Run it with launch.pyw (Desktop shortcut) or `python app.py`.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

import numpy as np

APP_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, APP_DIR)

import media  # noqa: E402
from splat import Worker  # noqa: E402
from version import VERSION  # noqa: E402

PORT = int(os.environ.get("SPLAT_GARDEN_PORT") or 48331)
DATA = os.environ.get("SPLAT_GARDEN_DATA") or os.path.join(os.environ.get("LOCALAPPDATA", APP_DIR), "SplatGarden")
CACHE = os.path.join(DATA, "cache")
UPLOADS = os.path.join(DATA, "uploads")
LOG = os.path.join(DATA, "server.log")
KEEP_MEDIA = 24
SAMPLE = "geranium-pot.jpg"  # public domain, Wikimedia Commons "Pot with geranium.jpg"
for d in (CACHE, UPLOADS):
    os.makedirs(d, exist_ok=True)

if sys.stdout is None or sys.stderr is None or "pythonw" in sys.executable.lower():
    _log = open(LOG, "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr = _log

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

app = FastAPI(title="Splat Garden")
WORKER = Worker(log=LOG)
JOBS = {}
INBOX = {"jobs": [], "scans": []}
EXPORTS = {}
_jobs_lock = threading.Lock()
_queue = []
_queue_cv = threading.Condition()
_arrays = {}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- media cache

def media_key(path, detail, start, seconds):
    """Same file contents + settings = same cache entry, so re-opening (or re-uploading) a file is instant."""
    size = os.path.getsize(path)
    h = hashlib.sha1(f"{os.path.basename(path).lower()}|{size}|{detail}|{start:.2f}|{seconds:.2f}|v1".encode())
    with open(path, "rb") as f:
        h.update(f.read(1 << 20))
        if size > 2 << 20:
            f.seek(-(1 << 20), os.SEEK_END)
            h.update(f.read(1 << 20))
    return h.hexdigest()[:14]


def media_dir(mid):
    if not mid or not all(c in "0123456789abcdef" for c in mid):
        raise HTTPException(404, "unknown media")
    return os.path.join(CACHE, mid)


def load_meta(mid):
    p = os.path.join(media_dir(mid), "meta.json")
    if not os.path.isfile(p):
        raise HTTPException(404, "media not ready")
    with open(p, encoding="utf-8") as f:
        m = json.load(f)
    m["id"] = mid
    m["thumb"] = f"/api/media/{mid}/thumb"
    return m


def arrays(mid):
    if mid not in _arrays:
        d = media_dir(mid)
        _arrays[mid] = (np.load(os.path.join(d, "rgba.npy"), mmap_mode="r"),
                        np.load(os.path.join(d, "disp.npy"), mmap_mode="r"))
    return _arrays[mid]


def prune_cache():
    items = []
    for name in os.listdir(CACHE):
        p = os.path.join(CACHE, name, "meta.json")
        if os.path.isfile(p):
            items.append((os.path.getmtime(p), name))
    for _, name in sorted(items, reverse=True)[KEEP_MEDIA:]:
        _arrays.pop(name, None)
        shutil.rmtree(os.path.join(CACHE, name), ignore_errors=True)


# ---------------------------------------------------------------- import jobs

def new_job(path, detail, start=0.0, seconds=15.0):
    kind = media.kind_of(path)
    if kind not in ("image", "video"):
        raise HTTPException(400, "Splat Garden opens photos and videos here (scans load in the window)")
    if not os.path.isfile(path):
        raise HTTPException(404, f"File not found: {path}")
    detail = int(min(1024, max(160, detail)))
    mid = media_key(path, detail, start, seconds)
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "media": mid, "state": "queued", "progress": 0.0, "message": "Waiting", "name": os.path.basename(path),
           "kind": kind, "error": None}
    if os.path.isfile(os.path.join(CACHE, mid, "meta.json")):
        os.utime(os.path.join(CACHE, mid, "meta.json"))
        job.update(state="done", progress=1.0, message="Ready (cached)", meta=load_meta(mid))
        JOBS[jid] = job
        return job
    JOBS[jid] = job
    with _queue_cv:
        _queue.append((jid, {"job": jid, "src": os.path.abspath(path), "out": os.path.join(CACHE, mid), "kind": kind,
                             "detail": detail, "start": start, "max_seconds": seconds}))
        _queue_cv.notify()
    return job


WORKER_IDLE = float(os.environ.get("SPLAT_GARDEN_WORKER_IDLE") or 600)  # seconds; the GPU worker holds ~1-2 GB of video memory, so give it back when idle


def job_loop():
    last = time.time()
    while True:
        with _queue_cv:
            while not _queue:
                _queue_cv.wait(timeout=30)
                if not _queue and WORKER.proc is not None and time.time() - last > WORKER_IDLE:
                    WORKER.stop()
                    WORKER.proc = None
                    log("depth worker stopped (idle), video memory freed")
            jid, spec = _queue.pop(0)
        job = JOBS[jid]
        job.update(state="running", message="Starting the depth worker")

        def on_progress(p, msg):
            job["progress"], job["message"] = p, msg

        t0 = time.time()
        try:
            shutil.rmtree(spec["out"], ignore_errors=True)
            WORKER.run(spec, on_progress)
            job.update(state="done", progress=1.0, message="Ready", meta=load_meta(job["media"]))
            log(f"import {job['name']}: {time.time() - t0:.1f}s")
            prune_cache()
        except Exception as e:
            shutil.rmtree(spec["out"], ignore_errors=True)
            job.update(state="error", error=str(e), message="Failed")
            log(f"import {job['name']} failed: {e}")
        last = time.time()


threading.Thread(target=job_loop, daemon=True).start()


# ---------------------------------------------------------------- API

@app.get("/api/ping")
def ping():
    return {"app": "splat-garden", "port": PORT, "version": VERSION}


@app.post("/api/quit")
def quit_server():
    """Used by the launcher to replace an older running server after an update."""
    def bye():
        time.sleep(0.3)
        WORKER.stop()
        log("quit (replaced by a newer version)")
        os._exit(0)
    threading.Thread(target=bye, daemon=True).start()
    return {"ok": True}


@app.get("/api/info")
def info():
    return {"output_dir": media.output_dir(), "cache": CACHE, "version": 1}


@app.get("/api/presets")
def presets():
    with open(os.path.join(APP_DIR, "presets.json"), encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/sample")
def sample():
    return new_job(os.path.join(APP_DIR, "sample", SAMPLE), 640)


@app.post("/api/reprocess")
async def reprocess(req: Request):
    b = await req.json()
    m = load_meta(b.get("media", ""))
    if not os.path.isfile(m.get("source", "")):
        raise HTTPException(404, "The original file is gone, open it again")
    seconds = max(1.0, m.get("duration") or 15.0) if m["kind"] == "video" else 15.0
    return new_job(m["source"], int(b.get("detail", m["detail"])), float(m.get("start", 0)), max(seconds, 20.0))


@app.post("/api/import")
async def import_upload(file: UploadFile = File(...), detail: int = Form(640), seconds: float = Form(15.0),
                        start: float = Form(0.0)):
    name = os.path.basename(file.filename or "upload")
    if media.kind_of(name) not in ("image", "video"):
        raise HTTPException(400, "Open a photo (jpg, png, webp) or a video (mp4, mov, webm)")
    folder = os.path.join(UPLOADS, uuid.uuid4().hex[:8])
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as f:
        while True:
            chunk = await file.read(4 << 20)
            if not chunk:
                break
            f.write(chunk)
    return new_job(path, detail, start, seconds)


@app.post("/api/import-paths")
async def import_paths(req: Request):
    """Files dropped on the Desktop shortcut: photos/videos start an import, scans are handed to the window."""
    body = await req.json()
    out = []
    for p in body.get("paths", []):
        k = media.kind_of(p)
        if k == "scan" and os.path.isfile(p):
            INBOX["scans"].append(os.path.abspath(p))
        elif k in ("image", "video") and os.path.isfile(p):
            job = new_job(p, int(body.get("detail", 640 if k == "image" else 480)))
            INBOX["jobs"].append(job["id"])
            out.append(job)
    return {"jobs": out}


@app.get("/api/inbox")
def inbox():
    jobs, scans = INBOX["jobs"][:], INBOX["scans"][:]
    INBOX["jobs"].clear()
    INBOX["scans"].clear()
    return {"jobs": [JOBS[j] for j in jobs if j in JOBS], "scans": [{"path": p, "name": os.path.basename(p)} for p in scans]}


@app.get("/api/scan-file")
def scan_file(path: str):
    if media.kind_of(path) != "scan" or not os.path.isfile(path):
        raise HTTPException(404, "not a scan")
    return FileResponse(path, media_type="application/octet-stream")


@app.get("/api/job/{jid}")
def job_status(jid: str):
    if jid not in JOBS:
        raise HTTPException(404, "unknown job")
    return JOBS[jid]


@app.get("/api/media")
def media_list():
    items = []
    for name in os.listdir(CACHE):
        p = os.path.join(CACHE, name, "meta.json")
        if os.path.isfile(p):
            try:
                m = load_meta(name)
                m["opened"] = os.path.getmtime(p)
                items.append(m)
            except Exception:
                pass
    items.sort(key=lambda m: m["opened"], reverse=True)
    return {"items": items}


@app.get("/api/media/{mid}")
def media_meta(mid: str):
    m = load_meta(mid)
    os.utime(os.path.join(media_dir(mid), "meta.json"))  # most recently opened first in Recent
    return m


@app.get("/api/media/{mid}/thumb")
def media_thumb(mid: str):
    p = os.path.join(media_dir(mid), "thumb.jpg")
    if not os.path.isfile(p):
        raise HTTPException(404, "no thumb")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/api/media/{mid}/frame/{i}")
def media_frame(mid: str, i: int):
    """One frame for the renderer: H*W*4 RGBA bytes (A = AI cut-out), then H*W little-endian uint16 disparity."""
    meta = load_meta(mid)
    rgba, disp = arrays(mid)
    i = int(i) % max(1, meta["frames"])
    body = rgba[i].tobytes() + disp[i].astype("<u2").tobytes()
    return Response(body, media_type="application/octet-stream", headers={"Cache-Control": "max-age=3600"})


@app.post("/api/export/start")
async def export_start(req: Request):
    b = await req.json()
    w, h = int(b.get("width", 1080)), int(b.get("height", 1080))
    if not (16 <= w <= 4096 and 16 <= h <= 4096):
        raise HTTPException(400, "bad size")
    fps, frames = float(b.get("fps", 24)), int(b.get("frames", 1))
    audio_src, audio_start = None, 0.0
    mid = b.get("media")
    if b.get("audio", True) and mid:
        try:
            m = load_meta(mid)
            if m.get("has_audio") and os.path.isfile(m.get("source", "")):
                audio_src, audio_start = m["source"], float(m.get("start", 0)) + float(b.get("audio_offset", 0))
        except HTTPException:
            pass
    fmt = b.get("format", "mp4")
    if fmt not in media.FORMATS:
        raise HTTPException(400, f"unknown format {fmt}")
    path = media.unique_path(media.output_dir(), b.get("name") or "Splat Garden", media.FORMATS[fmt])
    eid = uuid.uuid4().hex[:10]
    EXPORTS[eid] = media.Encoder(path, w, h, fps, audio_src, audio_start, seconds=frames / fps, fmt=fmt)
    log(f"export {eid} -> {path} ({fmt}, {w}x{h}, {frames} frames, audio={bool(audio_src)})")
    return {"id": eid, "path": path}


@app.post("/api/export/{eid}/frame")
async def export_frame(eid: str, req: Request):
    """One rendered frame: raw RGBA bytes, bottom-up as WebGL reads them (the encoder flips)."""
    enc = EXPORTS.get(eid)
    if enc is None:
        raise HTTPException(404, "unknown export")
    data = await req.body()
    try:
        enc.write(data)
    except Exception as e:
        EXPORTS.pop(eid, None)
        enc.cancel()
        raise HTTPException(500, f"encoder stopped: {e}")
    return {"n": enc.frames}


@app.post("/api/export/{eid}/finish")
def export_finish(eid: str):
    enc = EXPORTS.pop(eid, None)
    if enc is None:
        raise HTTPException(404, "unknown export")
    path = enc.close()
    return {"path": path, "frames": enc.frames, "bytes": os.path.getsize(path)}


@app.post("/api/export/{eid}/cancel")
def export_cancel(eid: str):
    enc = EXPORTS.pop(eid, None)
    if enc:
        enc.cancel()
    return {"ok": True}


@app.post("/api/save")
async def save_file(req: Request, name: str = "Splat Garden", ext: str = "png"):
    if ext not in ("png", "ply", "json"):
        raise HTTPException(400, "bad type")
    data = await req.body()
    path = media.unique_path(media.output_dir(), name, "." + ext)
    with open(path, "wb") as f:
        f.write(data)
    return {"path": path, "bytes": len(data)}


@app.post("/api/reveal")
async def reveal(req: Request):
    b = await req.json() if (req.headers.get("content-length") or "0") != "0" else {}
    p = b.get("path")
    if p and os.path.exists(p):
        subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
    else:
        os.startfile(media.output_dir())
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(os.path.join(APP_DIR, "static", "index.html"), headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def serve():
    import uvicorn
    media.no_throttle()
    log(f"Splat Garden on http://127.0.0.1:{PORT}/")
    try:
        uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", access_log=False)
    finally:
        WORKER.stop()


if __name__ == "__main__":
    serve()
