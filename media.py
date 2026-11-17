"""ffmpeg helpers for Splat Garden: probe and decode sources, and encode the MP4s the browser renders.

Rendering happens in the app window (WebGL). The browser posts each finished frame here and an ffmpeg pipe turns
the frames into an H.264 MP4, with the source video's sound when there is one.
"""
import json
import os
import shutil
import subprocess
import threading

import numpy as np

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".jfif"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".gif", ".wmv", ".mpg", ".mpeg"}
SCAN_EXT = {".ply", ".splat"}
APP_NAME = "Splat Garden"


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in SCAN_EXT:
        return "scan"
    return None


def ffmpeg_exe():
    return shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_exe():
    return shutil.which("ffprobe") or "ffprobe"


def no_throttle(pid=None):
    """Opt a process (default: this one) out of Windows power throttling (EcoQoS).

    Windows quietly slows down busy processes that have no window of their own (pythonw, ffmpeg pipes) by 8-10x
    after a few seconds. Returns True when the opt-out was applied.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes as wt

        class _PPT(ctypes.Structure):
            _fields_ = [("Version", wt.ULONG), ("ControlMask", wt.ULONG), ("StateMask", wt.ULONG)]

        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wt.HANDLE
        k.OpenProcess.restype = wt.HANDLE
        k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        k.SetProcessInformation.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
        k.SetProcessInformation.restype = wt.BOOL
        k.CloseHandle.argtypes = [wt.HANDLE]
        h = k.GetCurrentProcess() if pid is None else k.OpenProcess(0x0200 | 0x1000, False, pid)
        if not h:
            return False
        st = _PPT(1, 0x1, 0x0)  # execution-speed throttling: controlled by us, and off
        ok = bool(k.SetProcessInformation(h, 4, ctypes.byref(st), ctypes.sizeof(st)))  # 4 = ProcessPowerThrottling
        if pid is not None:
            k.CloseHandle(h)
        return ok
    except Exception:
        return False


def output_dir():
    """Finished renders go to Videos\\Splat Garden in your user folder.

    SPLAT_GARDEN_OUT overrides it (the tests use it to keep their renders in tests\\_out).
    """
    if os.environ.get("SPLAT_GARDEN_OUT"):
        os.makedirs(os.environ["SPLAT_GARDEN_OUT"], exist_ok=True)
        return os.environ["SPLAT_GARDEN_OUT"]
    base = os.path.join(os.path.expanduser("~"), "Videos", APP_NAME)
    os.makedirs(base, exist_ok=True)
    return base


def unique_path(folder, stem, ext):
    stem = "".join(c if c.isalnum() or c in " -_()." else "_" for c in stem).strip() or "splat"
    p = os.path.join(folder, stem + ext)
    n = 2
    while os.path.exists(p):
        p = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    return p


def probe(path):
    """Duration, size (after rotation), frame rate and whether there is sound."""
    out = subprocess.run([ffprobe_exe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
                         capture_output=True, creationflags=NO_WINDOW, timeout=60)
    info = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if v is None:
        raise ValueError("No video stream in this file")
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    rot = int(float((v.get("tags") or {}).get("rotate", rot)))
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, _, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "24/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 24.0
    dur = float(info.get("format", {}).get("duration") or v.get("duration") or 0)
    audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    return {"width": w, "height": h, "fps": fps or 24.0, "duration": dur, "has_audio": audio}


def read_frames(path, w, h, fps=24, start=0.0, seconds=None):
    """Yield the video's frames as HxWx3 uint8 arrays, resampled to `fps` and scaled to w x h."""
    cmd = [ffmpeg_exe(), "-v", "error", "-ss", f"{max(0.0, start):.3f}", "-i", path]
    if seconds:
        cmd += ["-t", f"{seconds:.3f}"]
    cmd += ["-an", "-vf", f"fps={fps},scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
    no_throttle(proc.pid)
    size = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


FORMATS = {  # export format -> file extension
    "mp4": ".mp4",      # H.264, opaque
    "prores": ".mov",   # ProRes 4444 with alpha (straight alpha, 10-bit 4:4:4, about Apple's data rate), PCM sound
}


class Encoder:
    """An ffmpeg pipe that takes raw RGBA frames (bottom-up, straight from WebGL readPixels) and writes the video.

    fmt "mp4": H.264 + AAC. fmt "prores": ProRes 4444 with the frames' alpha as transparency + PCM, for After
    Effects / Premiere / DaVinci / Final Cut / TouchDesigner.
    """

    def __init__(self, path, w, h, fps=24, audio_src=None, audio_start=0.0, seconds=None, flip=True, fmt="mp4"):
        self.path, self.w, self.h, self.frames = path, w, h, 0
        cmd = [ffmpeg_exe(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}",
               "-r", str(fps), "-i", "pipe:0"]
        if audio_src:
            cmd += ["-ss", f"{max(0.0, audio_start):.3f}", "-i", audio_src]
        vf = "vflip," if flip else ""
        cmd += ["-map", "0:v"] + (["-map", "1:a?"] if audio_src else [])
        if fmt == "prores":
            cmd += ["-vf", vf + "format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4444",
                    "-pix_fmt", "yuva444p10le", "-alpha_bits", "8", "-q:v", "8", "-vendor", "apl0"]
            if audio_src:
                cmd += ["-c:a", "pcm_s16le"]
        else:
            cmd += ["-vf", vf + "format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
                    "-movflags", "+faststart"]
            if audio_src:
                cmd += ["-c:a", "aac", "-b:a", "192k"]
        if seconds:
            cmd += ["-t", f"{seconds:.3f}"]
        cmd += [path]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
        no_throttle(self.proc.pid)
        self._err = b""
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        self._err = self.proc.stderr.read()

    def write(self, data):
        if len(data) != self.w * self.h * 4:
            raise ValueError(f"frame is {len(data)} bytes, expected {self.w * self.h * 4}")
        self.proc.stdin.write(data)
        self.frames += 1

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        code = self.proc.wait(timeout=300)
        if code != 0:
            raise RuntimeError("ffmpeg failed: " + self._err.decode("utf-8", "replace")[-600:])
        return self.path

    def cancel(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        try:
            os.remove(self.path)
        except OSError:
            pass
