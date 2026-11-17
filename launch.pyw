"""Desktop launcher: starts the Splat Garden server (if needed) and opens the app window.

Drop photos, videos or .ply/.splat scans onto the desktop shortcut to open them.
"""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("SPLAT_GARDEN_PORT") or 48331)
URL = f"http://127.0.0.1:{PORT}/"
LOCAL = os.environ.get("LOCALAPPDATA", APP_DIR)
sys.path.insert(0, APP_DIR)
from version import VERSION  # noqa: E402


def probe():
    """'ours' if this version of Splat Garden answers on the port, 'old' if an older one does, 'other' if
    something else does, None if the port is free."""
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=0.8) as r:
            body = r.read()
        if b"splat-garden" not in body:
            return "other"
        return "ours" if json.loads(body).get("version", 1) >= VERSION else "old"
    except urllib.error.HTTPError:
        return "other"
    except Exception:
        return None


def post_paths(paths):
    req = urllib.request.Request(URL + "api/import-paths", data=json.dumps({"paths": paths}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except Exception:
        pass


def replace_old_server():
    """An older Splat Garden is still running (the app was updated): ask it to quit, or end it, then start fresh."""
    try:
        urllib.request.urlopen(urllib.request.Request(URL + "api/quit", data=b"{}", method="POST"), timeout=2).read()
    except Exception:
        try:  # servers from before /api/quit: end the process that owns our port, if it is Splat Garden
            import psutil
            for c in psutil.net_connections("tcp"):
                if c.laddr and c.laddr.port == PORT and c.status == psutil.CONN_LISTEN and c.pid:
                    pr = psutil.Process(c.pid)
                    if any("splat-garden" in a.replace("\\", "/").lower() or a.endswith(("launch.pyw", "app.py")) for a in pr.cmdline()):
                        for ch in pr.children(recursive=True):
                            ch.kill()
                        pr.kill()
        except Exception:
            pass
    for _ in range(50):
        if probe() is None:
            return
        time.sleep(0.1)


def find_browser():
    pf, pf86 = os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    for p in (os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(LOCAL, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
              os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe")):
        if os.path.exists(p):
            return p
    return None


def open_window():
    if os.environ.get("SPLAT_GARDEN_NO_WINDOW"):  # tests
        return
    exe = find_browser()
    if not exe:
        webbrowser.open(URL)
        return
    profile = os.path.join(LOCAL, "SplatGarden", "window")
    subprocess.Popen([exe, f"--app={URL}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                      "--disable-features=Translate", "--ignore-gpu-blocklist", "--window-size=1600,980"],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def main():
    paths = [p for p in sys.argv[1:] if os.path.isfile(p)]
    who = probe()
    if who == "old":
        replace_old_server()
        who = probe()
    if who == "other":
        ctypes.windll.user32.MessageBoxW(None, f"Port {PORT} is used by another program, so Splat Garden cannot start. "
                                         "Close that program and try again.", "Splat Garden", 0x10)
        return
    if who == "ours":
        if paths:
            post_paths(paths)
        open_window()
        return

    import app  # redirects output to the log file

    def opener():
        for _ in range(300):
            if probe() == "ours":
                break
            time.sleep(0.1)
        if paths:
            post_paths(paths)
        open_window()

    threading.Thread(target=opener, daemon=True).start()
    app.serve()


if __name__ == "__main__":
    main()
