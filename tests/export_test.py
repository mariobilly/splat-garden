"""End-to-end export through the app window: source -> look -> Export MP4 / Save PNG / Save .ply -> reopen the .ply.

    python tests/export_test.py <source> <look> <seconds> [aspect]
Prints one JSON line with what was written. Needs the server running (see run_tests.py).
"""
import json
import sys
import time

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from shots import open_page, load_source  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


def main():
    src, look, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
    aspect = sys.argv[4] if len(sys.argv) > 4 else "1:1"
    out = {"source": src, "look": look, "aspect": aspect}
    with sync_playwright() as p:
        b, pg = open_page(p)
        load_source(pg, src)
        pg.evaluate(f"SG.applyLook({json.dumps(look)}); SG.setParam('duration', {secs}); SG.S.aspect = {json.dumps(aspect)};")
        t0 = time.time()
        pg.evaluate("SG.exportMp4()")
        pg.wait_for_function("SG.S.exporting === false && SG.S.lastExport", timeout=600000, polling=500)
        out["export_seconds"] = round(time.time() - t0, 1)
        out["mp4"] = pg.evaluate("SG.S.lastExport")
        out["stats"] = pg.evaluate("SG.S.lastExportStats")
        if "--extras" in sys.argv:
            pg.evaluate("SG.savePng()")
            pg.wait_for_timeout(1500)
            pg.evaluate("SG.savePly()")
            pg.wait_for_timeout(2500)
            out["toast"] = pg.inner_text("#toast")
        out["errors"] = [l for l in pg.logs if "error" in l.lower() and "icon.png" not in l]
        b.close()
    print(json.dumps(out))


if __name__ == "__main__":
    main()
