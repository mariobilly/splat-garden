"""Depth + cut-out for Splat Garden.

Turns a photo or a video into the frames the WebGL renderer builds its 3D gaussians from. Each frame is stored as
  rgba.u8  (frames, H, W, 4)  colour, and in alpha the AI cut-out (ISNet via rembg)
  disp.u16 (frames, H, W)     Depth Anything disparity, 0 = far, 65535 = near
plus meta.json and thumb.jpg, in the media's cache folder.

The GPU models run in their own worker process (`python splat.py --serve`, see Worker), so a model crash or the
1.3 GB of weights never sit inside the web server. Jobs go in as JSON lines on stdin; progress comes back as JSON
lines on stdout. The first import downloads the models once: the Depth Anything weights (about 1.3 GB) into the
Hugging Face cache and the ISNet model (about 170 MB) into rembg's folder (~\\.u2net). After that it works offline.
"""
import json
import os
import subprocess
import sys
import threading
import time

import numpy as np

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEPTH_REPO = "LiheYoung/depth-anything-large-hf"
VIDEO_FPS = 24
_S = {}


# ---------------------------------------------------------------- models (worker process only)

def _torch():
    import torch  # first, so onnxruntime's CUDA provider finds the CUDA / cuDNN libraries
    return torch


def _depth_model():
    if "depth" not in _S:
        torch = _torch()
        from transformers import AutoModelForDepthEstimation
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if dev == "cuda" else torch.float32
        try:  # cached: load without asking the Hugging Face Hub
            m = AutoModelForDepthEstimation.from_pretrained(DEPTH_REPO, local_files_only=True, dtype=dtype)
        except OSError:  # first run: download the weights (about 1.3 GB) into the Hugging Face cache
            m = AutoModelForDepthEstimation.from_pretrained(DEPTH_REPO, dtype=dtype)
        _S["depth"] = (m.to(dev).eval(), dev, dtype)
    return _S["depth"]


def _matte_session():
    if "matte" not in _S:
        _torch()
        from rembg import new_session
        _S["matte"] = new_session("isnet-general-use", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    return _S["matte"]


def depth(frames, min_side=518):
    """Relative disparity (bigger = nearer) for a list of HxWx3 uint8 frames of the same size."""
    torch = _torch()
    import torch.nn.functional as F
    model, dev, dtype = _depth_model()
    h, w = frames[0].shape[:2]
    s = min_side / min(h, w)
    th, tw = max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)
    with torch.inference_mode():
        x = torch.from_numpy(np.stack(frames)).to(dev).permute(0, 3, 1, 2).float() / 255.0
        x = F.interpolate(x, (th, tw), mode="bicubic", align_corners=False).clamp(0, 1)
        mean = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1)
        x = ((x - mean) / std).to(dtype)
        d = model(pixel_values=x).predicted_depth.float()
        d = F.interpolate(d[:, None], (h, w), mode="bilinear", align_corners=False)[:, 0]
    return [a for a in d.cpu().numpy()]


def matte(frame):
    """AI cut-out of the main subject, float32 0..1, same size as the frame."""
    from PIL import Image
    from rembg import remove
    m = remove(Image.fromarray(frame), session=_matte_session(), only_mask=True, post_process_mask=False)
    m = np.asarray(m, np.float32) / 255.0
    if m.shape != frame.shape[:2]:
        import cv2
        m = cv2.resize(m, (frame.shape[1], frame.shape[0]), interpolation=cv2.INTER_LINEAR)
    return m


# ---------------------------------------------------------------- processing

def fit(w, h, long_side):
    s = long_side / max(w, h)
    return max(2, round(w * s / 2) * 2), max(2, round(h * s / 2) * 2)


class _Norm:
    """Maps raw disparity to 0..1 with robust percentiles, smoothed over time so video depth does not pump."""

    def __init__(self, smooth):
        self.lo = self.hi = None
        self.k = smooth

    def __call__(self, d):
        lo, hi = np.percentile(d, [0.5, 99.5])
        if self.lo is None or not self.k:
            self.lo, self.hi = lo, hi
        else:
            self.lo = self.lo * self.k + lo * (1 - self.k)
            self.hi = self.hi * self.k + hi * (1 - self.k)
        return np.clip((d - self.lo) / max(1e-6, self.hi - self.lo), 0.0, 1.0)


def process(src, out, kind, detail=640, start=0.0, max_seconds=15.0, progress=lambda p, m: None):
    """Process `src` into the cache folder `out`. Returns the meta dict (also written to out/meta.json)."""
    import cv2
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    progress(0.01, "Loading the depth model (the first time, it downloads about 1.3 GB)")
    _depth_model()
    progress(0.04, "Loading the cut-out model (the first time, it downloads about 170 MB)")
    _matte_session()

    if kind == "image":
        from PIL import Image, ImageOps
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        big = np.asarray(im)
        if max(big.shape[:2]) > 2048:
            s = 2048 / max(big.shape[:2])
            big = cv2.resize(big, (round(big.shape[1] * s), round(big.shape[0] * s)), interpolation=cv2.INTER_AREA)
        sources, fps, info = [big], VIDEO_FPS, {"has_audio": False, "duration": 0.0}
        count = 1
    else:
        from media import probe, read_frames
        info = probe(src)
        dur = max(0.0, info["duration"] - start) if info["duration"] else max_seconds
        seconds = min(max_seconds, dur) if max_seconds else dur
        count = max(1, int(seconds * VIDEO_FPS + 0.5))
        bw, bh = fit(info["width"], info["height"], 1024)
        sources, fps = read_frames(src, bw, bh, VIDEO_FPS, start, seconds), VIDEO_FPS

    rgba = disp = None
    norm = _Norm(0.85 if kind == "video" else 0)
    batch, done = [], 0
    min_side = 700 if kind == "image" else 518

    def flush():
        nonlocal rgba, disp, done
        ds = depth(batch, min_side)
        for big, d in zip(batch, ds):
            if rgba is None:
                w, h = fit(big.shape[1], big.shape[0], detail)
                rgba = np.lib.format.open_memmap(os.path.join(out, "rgba.npy"), "w+", np.uint8, (count, h, w, 4))
                disp = np.lib.format.open_memmap(os.path.join(out, "disp.npy"), "w+", np.uint16, (count, h, w))
            if done >= count:
                break
            h, w = rgba.shape[1:3]
            a = matte(big)
            rgba[done, :, :, :3] = cv2.resize(big, (w, h), interpolation=cv2.INTER_AREA)
            rgba[done, :, :, 3] = np.clip(cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA) * 255 + 0.5, 0, 255)
            nd = norm(cv2.resize(d, (w, h), interpolation=cv2.INTER_AREA))
            disp[done] = np.clip(nd * 65535 + 0.5, 0, 65535).astype(np.uint16)
            done += 1
        batch.clear()
        progress(0.06 + 0.92 * done / count, f"Depth + cut-out {done}/{count}" if count > 1 else "Depth + cut-out")

    for big in sources:
        batch.append(np.ascontiguousarray(big))
        if len(batch) >= 4:
            flush()
        if done >= count:
            break
    if batch:
        flush()
    if rgba is None or done == 0:
        raise ValueError("Could not read any frames from this file")
    count = done
    h, w = rgba.shape[1:3]
    rgba.flush()
    disp.flush()

    # one raw blob per frame layout the browser reads directly: RGBA bytes then little-endian uint16 disparity
    from PIL import Image
    th = Image.fromarray(np.ascontiguousarray(rgba[0, :, :, :3]))
    th.thumbnail((320, 320))
    th.save(os.path.join(out, "thumb.jpg"), quality=85)
    meta = {"kind": kind, "width": int(w), "height": int(h), "frames": int(count), "fps": fps,
            "duration": count / fps if kind == "video" else 0.0, "start": float(start),
            "has_audio": bool(info.get("has_audio")), "source": os.path.abspath(src), "name": os.path.basename(src),
            "detail": int(detail), "seconds_to_process": round(time.time() - t0, 2), "version": 1}
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    progress(1.0, "Ready")
    return meta


# ---------------------------------------------------------------- worker process

def serve():
    """Worker loop: one JSON job per stdin line, JSON progress lines on stdout."""
    try:
        from media import no_throttle
        no_throttle()
    except Exception:
        pass
    out = sys.stdout
    sys.stdout = sys.stderr  # stray prints from libraries must not corrupt the protocol

    def say(obj):
        out.write(json.dumps(obj) + "\n")
        out.flush()

    say({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        jid = job.get("job")
        try:
            meta = process(job["src"], job["out"], job["kind"], int(job.get("detail", 640)),
                           float(job.get("start", 0)), float(job.get("max_seconds", 15)),
                           lambda p, m: say({"job": jid, "progress": round(p, 4), "message": m}))
            say({"job": jid, "done": True, "meta": meta})
        except Exception as e:
            import traceback
            traceback.print_exc()
            say({"job": jid, "error": f"{type(e).__name__}: {e}"})


class Worker:
    """The server's handle on the GPU worker process: started on first use, restarted if it dies."""

    def __init__(self, log=None):
        self.proc = None
        self.lock = threading.Lock()
        self.log = log

    def _start(self):
        py = sys.executable
        if py.lower().endswith("pythonw.exe"):
            alt = py[:-len("pythonw.exe")] + "python.exe"
            py = alt if os.path.exists(alt) else py
        err = open(self.log, "ab") if self.log else subprocess.DEVNULL
        self.proc = subprocess.Popen([py, "-u", os.path.join(APP_DIR, "splat.py"), "--serve"], cwd=APP_DIR,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            from media import no_throttle
            no_throttle(self.proc.pid)
        except Exception:
            pass
        first = json.loads(self.proc.stdout.readline() or b"{}")
        if not first.get("ready"):
            raise RuntimeError("The depth worker did not start (see server.log)")

    def run(self, job, on_progress):
        """Run one job to the end (blocking). Returns the meta dict or raises."""
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            self.proc.stdin.write((json.dumps(job) + "\n").encode())
            self.proc.stdin.flush()
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    self.proc = None
                    raise RuntimeError("The depth worker stopped unexpectedly (see server.log)")
                msg = json.loads(line)
                if msg.get("job") != job["job"]:
                    continue
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                if msg.get("done"):
                    return msg["meta"]
                on_progress(msg.get("progress", 0), msg.get("message", ""))

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    elif len(sys.argv) >= 3:  # manual run: python splat.py <src> <out folder> [detail]
        from media import kind_of
        m = process(sys.argv[1], sys.argv[2], kind_of(sys.argv[1]), int(sys.argv[3]) if len(sys.argv) > 3 else 640,
                    progress=lambda p, msg: print(f"{p:5.0%} {msg}", flush=True))
        print(json.dumps(m, indent=1))
