# Splat Garden

Turns your photos and videos into **Gaussian-splat "scans"** with a camera flying around them: plants floating on a
saturated blue void, dripping into vertical streaks, smeared, held in a soft sphere, or the whole scene turned to
felt or caught in a vortex. You can also open real `.ply` / `.splat` scans.

**Everything runs on your computer. No account, no API key, nothing is uploaded.**

Inspired by the Gaussian-splat reels by [vanity ibex](https://www.instagram.com/reel/DdeFgPlCKy4/). Splat Garden is
an independent project and shares no code with them.

## Install

You need:
- Windows 10 or 11 (it is built and tested on Windows 11)
- [Python](https://www.python.org/downloads/) 3.11 or newer
- [ffmpeg](https://ffmpeg.org/download.html) on your PATH (ffmpeg and ffprobe), for videos and exports
- Google Chrome or Microsoft Edge: the app opens in its own window and renders the splats with WebGL2
- An NVIDIA GPU makes the depth and cut-out step fast. Without one it runs on the CPU, which is much slower.

Install PyTorch first, from [pytorch.org](https://pytorch.org/get-started/locally/) (pick the CUDA build if you have
an NVIDIA GPU). Then:

```
python -m pip install -r requirements.txt
python launch.pyw
```

The first photo or video you open downloads two models once, for free: Depth Anything
([`LiheYoung/depth-anything-large-hf`](https://huggingface.co/LiheYoung/depth-anything-large-hf), about 1.3 GB) into
your Hugging Face cache, and rembg's ISNet cut-out model (about 170 MB) into `~\.u2net`. After that it works offline.
For a GPU cut-out, install `onnxruntime-gpu` instead of `onnxruntime`.

Optional: `powershell -ExecutionPolicy Bypass -File tools\make_shortcut.ps1` puts a **Splat Garden** shortcut on your
Desktop. You can drop a photo, a video or a `.ply` / `.splat` scan onto it.

## How it works
1. **Depth + cut-out** (`splat.py`, in its own worker process). Each photo, or each video frame at 24 fps, goes
   through Depth Anything and the ISNet cut-out (rembg `isnet-general-use`). The results are cached per file, so
   re-opening a file is instant.
2. **Splats** (`static/splat.js`). Every pixel becomes a 3D gaussian at its depth, lying flat on the local surface.
   Across a depth jump a gaussian stretches like a rubber sheet, which is exactly where real splat scans tear.
   Whole-scene looks also get a soft backdrop layer, so the camera never sees "behind" the photo.
3. **Look**. The scan artifacts run per splat on the GPU (drips, veils, floaters, smear, swirl, felt, sphere crop).
   They are followed by a post pass (glitch blocks, pixel stretch, grade, soften, glow, grain, vignette). Every
   slider is live.
4. **Export**. The window renders each frame at full size. `media.py` pipes the frames into ffmpeg and adds the source
   video's sound. There are two formats:
   - **MP4**: H.264, CRF 16, with AAC sound.
   - **ProRes 4444 · transparent**: a `.mov` with alpha and PCM sound.

## The five looks (keys 1–5)
| Look | What it does |
|---|---|
| **Drip Pot** | Cut-out + nearest things on blue, columns dripping into crisp vertical streaks, orbit |
| **Ember** | Smeared flowers, fire-like streaks pouring from their lower half, floaters, pink glitch blocks, fly-through |
| **Bubble** | The scan inside a soft sphere, pale veils rising, pastel grade |
| **Felt** | Whole scene as fuzzy needle splats, crushed blacks, push in |
| **Swirl** | Whole scene drifting while a vortex grows in the foreground |

The presets live in `presets.json`. Each one only lists what differs from the defaults in `static/app.js`.

## How to use it
- Open a photo or a video, or press **Try the sample**.
- **Keep** picks what survives:
  - **Cut-out subject**: the AI matte.
  - **Nearest things**: a depth cut.
  - **Cut-out + nearest things**: both together. This is best for plants, because the AI sometimes keeps only the
    pot.
  - **Whole scene**: nothing is removed.
- **Depth** sets how deep the relief is. **Edge stretch** sets how far splats tear across depth jumps.
- Drag in the view to look around, scroll to zoom and double-click (or press `R`) to reset. Dragging is kept in the
  export.
- **Clip length** sets the export length (videos default to their own length). The shape menu picks 1:1, 4:5, 9:16
  or 16:9.
- **Detail** sets the splat resolution: about 640 px on the long side for photos, 480 px for videos. Use
  **Re-process at this detail** to apply it.
- **Export** (`E`), **Save PNG**, **Save .ply** (opens in SuperSplat / Postshot) and **Folder** are in the top bar.
- **Transparent video.** Set the format menu next to Export to **ProRes 4444 · transparent**.
  - The background colour becomes real transparency (alpha). The splats keep their soft edges, so drips, veils,
    floaters and glitch blocks fade over whatever goes underneath.
  - The view shows a checkerboard where it will be transparent.
  - It opens with transparency in After Effects, Premiere, DaVinci, Final Cut and TouchDesigner, and the video's
    sound is kept.
  - Expect about 80 MB per 5 s at 1080×1080 (Apple's ProRes 4444 data rate).
  - **Save PNG** in this mode also keeps the transparency.
  - Use a cut-out **Keep** setting. With **Whole scene**, the scene fills the frame, so there is little to make
    transparent.

## Where exports go
Videos, PNGs and `.ply` files go to `Videos\Splat Garden` in your user folder. Set the `SPLAT_GARDEN_OUT` environment
variable to use another folder. Existing files are never overwritten.

## What's where
| Path | What |
|---|---|
| `app.py` | Local server (FastAPI) on **127.0.0.1:48331**: imports, frame cache, export pipe |
| `splat.py` | Depth + cut-out processing, run in its own worker process |
| `media.py` | ffmpeg probe/decode/encode, output folder, Windows power-throttling fix |
| `launch.pyw` | The launcher: starts the server and opens the Chrome or Edge app window |
| `version.py` | The server version; the launcher replaces an older running server after an update |
| `presets.json` | The five looks |
| `static/` | The app window: `index.html`, `app.js` (UI), `splat.js` (WebGL2 renderer), `sort-worker.js`, `style.css` |
| `sample/` | The "Try the sample" photo (public domain, see `sample/CREDITS.md`) |
| `tests/` | `run_tests.py` (everything + report), `shots.py`, `export_test.py`, `smoke.py`, and the test sources in `tests/sources/` |
| `tools/` | `make_icon.py`, `make_shortcut.ps1` |

- **Cache:** `%LOCALAPPDATA%\SplatGarden\cache` (keeps the last 24 sources). The log is `server.log` in
  `%LOCALAPPDATA%\SplatGarden`.

## Notes
- Photos and videos are 2.5D (one viewpoint), so the camera is kept within a few tens of degrees. Further round, you
  see the torn, stretched edges, which is part of the look. Real scans (`.ply`/`.splat`) can be orbited all the way.
- Videos are processed up to 20 s from the start, at 24 fps.
- Port 48331 is Splat Garden's. If something else holds it, the launcher says so.
- The GPU worker gives its video memory back after 10 minutes without imports.

## Tests
```
python -m pip install playwright psutil
python tests/run_tests.py
```
It starts its own server on port 48339 and a headless Chrome, checks the server, every look, every slider, the
controls and the MP4 / ProRes / PNG / `.ply` exports, then writes `tests\_out\report.html` with the results, renders
and screenshots. It needs Chrome, ffmpeg and a GPU. The test sources are in `tests/sources/` (public domain and CC0,
listed in [tests/sources/CREDITS.md](tests/sources/CREDITS.md)).

## Credits
- Inspiration: the Gaussian-splat reels by vanity ibex:
  [1](https://www.instagram.com/reel/DdeFgPlCKy4/), [2](https://www.instagram.com/reel/DdeFekgiNjR/),
  [3](https://www.instagram.com/reel/DdeFkxdiMFY/), [4](https://www.instagram.com/reel/DdeFhdeCGxM/),
  [5](https://www.instagram.com/reel/DdeFi_iCK5N/).
- Sample photo: [Pot with geranium.jpg](https://commons.wikimedia.org/wiki/File:Pot_with_geranium.jpg) by Kattusa24,
  Wikimedia Commons (public domain).
- Test sources: public domain and CC0, listed in [tests/sources/CREDITS.md](tests/sources/CREDITS.md).
- [Depth Anything](https://huggingface.co/LiheYoung/depth-anything-large-hf) (Apache-2.0) through
  [transformers](https://github.com/huggingface/transformers), and [rembg](https://github.com/danielgatis/rembg) (MIT)
  with the ISNet model, for depth and cut-outs.

## Licence

Splat Garden's own code is MIT, see [LICENSE](LICENSE). The libraries and models above keep their own licences.
