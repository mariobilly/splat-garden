// Splat Garden app window: sources, looks, controls, playback and export.
import { Renderer, buildDepthSet, parseScan, writePly, cameraFor } from '/static/splat.js';

const $ = (id) => document.getElementById(id);
const FPS = 24;

// Every control. build:true means the splats are rebuilt from the source when it changes (the rest is live on the GPU).
// `parent` hides a slider while its parent effect is off.
const SCHEMA = [
  { sec: 'Source', open: true, items: [
    { k: 'matte', label: 'Keep', type: 'select', build: true, options: [['ai', 'Cut-out subject (blue void)'], ['depth', 'Nearest things'], ['both', 'Cut-out + nearest things'], ['none', 'Whole scene']] },
    { k: 'cutoff', label: 'Cut-out threshold', min: 0.02, max: 0.95, step: 0.01, def: 0.3, build: true, show: P => P.matte === 'ai' || P.matte === 'both' },
    { k: 'depthCut', label: 'Depth cut', min: 0, max: 1, step: 0.01, def: 0.4, build: true, show: P => P.matte === 'depth' || P.matte === 'both' },
    { k: 'feather', label: 'Edge softness', min: 0.01, max: 0.4, step: 0.01, def: 0.08, build: true, show: P => P.matte !== 'none' },
    { k: 'relief', label: 'Depth', min: 0, max: 0.9, step: 0.01, def: 0.35, build: true },
    { k: 'fill', label: 'Fill gaps', min: 0, max: 1, step: 0.01, def: 1, show: P => P.matte === 'none' },
    { k: 'edge', label: 'Edge stretch', min: 0, max: 12, step: 0.1, def: 2, build: true },
    { k: 'fov', label: 'Lens angle', min: 25, max: 100, step: 1, def: 55, build: true, unit: '°' },
    { k: 'detail', label: 'Detail', type: 'select', options: [['360', 'Low · 360 px'], ['480', 'Medium · 480 px'], ['640', 'High · 640 px'], ['800', 'Ultra · 800 px']], def: '640', noLook: true },
  ] },
  { sec: 'Splats', open: true, items: [
    { k: 'scale', label: 'Splat size', min: 0.3, max: 3, step: 0.01, def: 1 },
    { k: 'opacity', label: 'Opacity', min: 0.05, max: 1, step: 0.01, def: 1 },
    { k: 'jitter', label: 'Depth fuzz', min: 0, max: 1, step: 0.01, def: 0.15 },
    { k: 'fuzz', label: 'Felt', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'fuzzLen', label: 'Fibre length', min: 1, max: 20, step: 0.1, def: 6, parent: 'fuzz' },
  ] },
  { sec: 'Artifacts', open: true, items: [
    { k: 'drip', label: 'Drips', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'dripLen', label: 'Length', min: 0.05, max: 3, step: 0.01, def: 0.9, parent: 'drip' },
    { k: 'dripWidth', label: 'Width', min: 1, max: 16, step: 1, def: 3, parent: 'drip' },
    { k: 'dripDir', label: 'Direction', type: 'select', options: [['down', 'Down'], ['up', 'Up'], ['both', 'Both']], def: 'both', parent: 'drip' },
    { k: 'dripSpeed', label: 'Motion', min: 0, max: 3, step: 0.01, def: 0.25, parent: 'drip' },
    { k: 'dripStart', label: 'Start from', min: 0, max: 0.95, step: 0.01, def: 0, parent: 'drip' },
    { k: 'veil', label: 'Veils', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'veilLen', label: 'Length', min: 0.1, max: 3, step: 0.01, def: 0.9, parent: 'veil' },
    { k: 'floaters', label: 'Floaters', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'floaterSize', label: 'Size', min: 0.2, max: 4, step: 0.01, def: 1, parent: 'floaters' },
    { k: 'smear', label: 'Smear', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'smearLen', label: 'Length', min: 0.1, max: 3, step: 0.01, def: 1, parent: 'smear' },
    { k: 'smearAngle', label: 'Angle', min: -90, max: 90, step: 1, def: 0, unit: '°', parent: 'smear' },
    { k: 'swirl', label: 'Swirl', min: -8, max: 8, step: 0.01, def: 0 },
    { k: 'swirlRadius', label: 'Radius', min: 0.1, max: 3, step: 0.01, def: 1, parent: 'swirl' },
    { k: 'swirlX', label: 'Centre X', min: -1.5, max: 1.5, step: 0.01, def: 0, parent: 'swirl' },
    { k: 'swirlY', label: 'Centre Y', min: -1.5, max: 1.5, step: 0.01, def: 0, parent: 'swirl' },
    { k: 'swirlRamp', label: 'Grow over clip', min: 0, max: 1, step: 0.01, def: 0, parent: 'swirl' },
    { k: 'sphere', label: 'Sphere crop', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'sphereRadius', label: 'Radius', min: 0.2, max: 2.5, step: 0.01, def: 1, parent: 'sphere' },
    { k: 'sphereSoft', label: 'Softness', min: 0.02, max: 1, step: 0.01, def: 0.3, parent: 'sphere' },
    { k: 'sphereSquash', label: 'Squash', min: 0.3, max: 1.6, step: 0.01, def: 0.8, parent: 'sphere' },
    { k: 'blocks', label: 'Glitch blocks', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'blockSize', label: 'Size', min: 0.3, max: 3, step: 0.01, def: 1, parent: 'blocks' },
    { k: 'blockRate', label: 'Changes / s', min: 0, max: 24, step: 0.5, def: 5, parent: 'blocks' },
    { k: 'blockShift', label: 'Shift', min: 0, max: 3, step: 0.01, def: 1, parent: 'blocks' },
    { k: 'stretch', label: 'Pixel stretch', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'stretchSize', label: 'Size', min: 0.3, max: 3, step: 0.01, def: 1, parent: 'stretch' },
  ] },
  { sec: 'Camera', open: true, items: [
    { k: 'motion', label: 'Move', type: 'select', options: [['orbit', 'Orbit'], ['sweep', 'Sweep across'], ['fly', 'Fly-through'], ['push', 'Push in'], ['drift', 'Drift'], ['still', 'Still']], def: 'orbit' },
    { k: 'amount', label: 'Swing', min: 0, max: 70, step: 0.5, def: 26, unit: '°' },
    { k: 'pitch', label: 'Height', min: -40, max: 50, step: 0.5, def: 10, unit: '°' },
    { k: 'tilt', label: 'Bob', min: 0, max: 30, step: 0.5, def: 6, unit: '°' },
    { k: 'dolly', label: 'Dolly', min: 0, max: 0.7, step: 0.01, def: 0.08 },
    { k: 'roll', label: 'Roll', min: 0, max: 20, step: 0.5, def: 0, unit: '°' },
    { k: 'cycles', label: 'Loops per clip', min: 0.5, max: 4, step: 0.5, def: 1 },
    { k: 'zoom', label: 'Zoom', min: 0.3, max: 3, step: 0.01, def: 1 },
    { k: 'frame', label: 'Frame on', type: 'select', options: [['subject', 'The subject'], ['source', 'The whole picture']], def: 'subject' },
    { k: 'duration', label: 'Clip length', type: 'select', options: [['5', '5 s'], ['8', '8 s'], ['10', '10 s'], ['12.5', '12.5 s'], ['15', '15 s'], ['20', '20 s']], def: '12.5', num: true },
  ] },
  { sec: 'Colour', open: false, items: [
    { k: 'bg', label: 'Background', type: 'color', def: '#0035ff' },
    { k: 'exposure', label: 'Exposure', min: 0.3, max: 2.5, step: 0.01, def: 1 },
    { k: 'contrast', label: 'Contrast', min: 0.4, max: 2, step: 0.01, def: 1 },
    { k: 'saturation', label: 'Saturation', min: 0, max: 2.2, step: 0.01, def: 1 },
    { k: 'blacks', label: 'Crush blacks', min: 0, max: 0.5, step: 0.005, def: 0 },
    { k: 'lift', label: 'Fade', min: 0, max: 0.5, step: 0.005, def: 0 },
    { k: 'warmth', label: 'Warmth', min: -1, max: 1, step: 0.01, def: 0 },
    { k: 'tint', label: 'Tint colour', type: 'color', def: '#c8ffe0' },
    { k: 'tintAmt', label: 'Tint', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'soften', label: 'Soften', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, def: 0 },
    { k: 'grain', label: 'Grain', min: 0, max: 0.3, step: 0.005, def: 0 },
    { k: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, def: 0 },
  ] },
];
const ITEMS = SCHEMA.flatMap(s => s.items);
const DEFAULTS = Object.fromEntries(ITEMS.map(i => [i.k, i.num ? Number(i.def) : (i.def ?? (i.type === 'select' ? i.options[0][0] : 0))]));
DEFAULTS.seed = 0;
const BUILD_KEYS = new Set(ITEMS.filter(i => i.build).map(i => i.k));
const SIZES = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '16:9': [1920, 1080] };

const S = {
  P: { ...DEFAULTS }, look: null, looks: [],
  media: null, scanName: null, set: null,
  frames: new Map(), loading: new Set(), builtIdx: -1, needBuild: false,
  playing: true, time: 0, last: 0, dirty: true,
  user: { yaw: 0, pitch: 0, zoom: 1 }, aspect: '1:1',
  exporting: false, cancel: false, format: 'mp4',
};
const transparent = () => S.format === 'prores';
let R;

// ------------------------------------------------------------------ persistence (this viewer only)
function saveState() {
  try { localStorage.setItem('splatGarden', JSON.stringify({ P: S.P, look: S.look, aspect: S.aspect, media: S.media?.id, format: S.format })); } catch (e) { /* private window */ }
}
function loadState() {
  try { return JSON.parse(localStorage.getItem('splatGarden') || 'null'); } catch (e) { return null; }
}

// ------------------------------------------------------------------ small UI helpers
let toastTimer;
function toast(msg, opts = {}) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  for (const [label, fn] of opts.buttons || []) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; t.appendChild(b); }
  t.className = opts.error ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), opts.ms || (opts.buttons ? 9000 : 3500));
}
function busy(title, p, msg, cancel) {
  if (title === null) { $('busy').hidden = true; return; }
  $('busy').hidden = false;
  $('busyTitle').textContent = title;
  $('busyBar').style.width = `${Math.round((p || 0) * 100)}%`;
  $('busyMsg').textContent = msg || '';
  $('busyCancel').hidden = !cancel;
  $('busyCancel').onclick = cancel || null;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (e) { /* not json */ } throw new Error(m); }
  return r;
}
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const fmt = (v, it) => (it.unit === '°' ? Math.round(v) + '°' : Math.abs(v) >= 10 ? (+v).toFixed(1) : (+v).toFixed(2));

// ------------------------------------------------------------------ controls
function buildControls() {
  const root = $('controls');
  root.innerHTML = '';
  for (const sec of SCHEMA) {
    const d = document.createElement('details'); d.open = sec.open;
    const s = document.createElement('summary'); s.textContent = sec.sec; d.appendChild(s);
    if (sec.sec === 'Source') {
      const n = document.createElement('div'); n.className = 'note'; n.id = 'srcNote'; d.appendChild(n);
    }
    for (const it of sec.items) {
      const row = document.createElement('div'); row.className = 'ctl' + (it.parent ? ' sub' : ''); row.dataset.k = it.k;
      const lab = document.createElement('label'); lab.textContent = it.label; lab.title = it.label; row.appendChild(lab);
      let input;
      if (it.type === 'select') {
        input = document.createElement('select');
        for (const [v, t] of it.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); }
        input.onchange = () => setParam(it.k, it.num ? Number(input.value) : input.value);
      } else if (it.type === 'color') {
        input = document.createElement('input'); input.type = 'color';
        input.oninput = () => setParam(it.k, input.value);
      } else {
        input = document.createElement('input'); input.type = 'range'; input.min = it.min; input.max = it.max; input.step = it.step;
        const val = document.createElement('span'); val.className = 'val';
        input.oninput = () => { setParam(it.k, Number(input.value)); val.textContent = fmt(input.value, it); };
        input.ondblclick = () => { const v = (S.look ? lookParams(S.look) : DEFAULTS)[it.k]; setParam(it.k, v); syncControls(); };
        row.appendChild(input); row.appendChild(val);
      }
      input.id = 'c_' + it.k;
      if (!row.contains(input)) row.appendChild(input);
      d.appendChild(row);
    }
    if (sec.sec === 'Source') {
      const br = document.createElement('div'); br.className = 'btnRow';
      const b = document.createElement('button'); b.textContent = 'Re-process at this detail'; b.id = 'btnReprocess';
      b.onclick = reprocess; br.appendChild(b); d.appendChild(br);
    }
    if (sec.sec === 'Artifacts') {
      const br = document.createElement('div'); br.className = 'btnRow';
      const b = document.createElement('button'); b.textContent = 'Shuffle glitches';
      b.onclick = () => { setParam('seed', Math.floor(Math.random() * 1000)); }; br.appendChild(b); d.appendChild(br);
    }
    root.appendChild(d);
  }
  syncControls();
}

function syncControls() {
  for (const it of ITEMS) {
    const el = $('c_' + it.k); if (!el) continue;
    const v = S.P[it.k];
    el.value = it.num ? String(v) : v;
    if (it.type !== 'select' && it.type !== 'color') el.nextElementSibling.textContent = fmt(v, it);
    const row = el.closest('.ctl');
    const hide = (it.show && !it.show(S.P)) || (it.parent && !S.P[it.parent]);
    row.classList.toggle('hidden', !!hide);
  }
  document.querySelectorAll('.look').forEach(b => b.classList.toggle('on', b.dataset.id === S.look));
  const note = $('srcNote');
  if (note) {
    if (S.media) note.textContent = `${S.media.name} · ${S.media.width}×${S.media.height}${S.media.kind === 'video' ? ` · ${S.media.frames} frames` : ''}`;
    else if (S.scanName) note.textContent = `Scan: ${S.scanName} (the depth controls only apply to photos and videos)`;
    else note.textContent = 'Open a photo or a video to start.';
  }
  const rp = $('btnReprocess'); if (rp) rp.disabled = !S.media || String(S.media.detail) === String(S.P.detail);
}

function setParam(k, v) {
  S.P[k] = v;
  if (BUILD_KEYS.has(k)) S.needBuild = true;
  if (k === 'duration') S.time = Math.min(S.time, S.P.duration - 1e-3);
  S.dirty = true;
  syncVisibility();
  saveStateSoon();
}
function syncVisibility() {
  for (const it of ITEMS) {
    if (!it.parent && !it.show) continue;
    const el = $('c_' + it.k); if (!el) continue;
    const hide = (it.show && !it.show(S.P)) || (it.parent && !S.P[it.parent]);
    el.closest('.ctl').classList.toggle('hidden', !!hide);
  }
  const rp = $('btnReprocess'); if (rp) rp.disabled = !S.media || String(S.media.detail) === String(S.P.detail);
}
let saveTimer;
function saveStateSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); }

function lookParams(id) {
  const L = S.looks.find(l => l.id === id);
  const keep = { detail: S.P.detail };
  return { ...DEFAULTS, ...(L ? L.params : {}), ...keep };
}
function applyLook(id) {
  const prev = S.P;
  S.P = lookParams(id);
  S.look = id;
  if (S.media?.kind === 'video') S.P.duration = videoDuration();
  if (BUILD_KEYS.size && [...BUILD_KEYS].some(k => prev[k] !== S.P[k])) S.needBuild = true;
  S.user = { yaw: 0, pitch: 0, zoom: 1 };
  S.dirty = true;
  syncControls(); saveStateSoon();
}
function videoDuration() {
  const d = S.media.frames / FPS;
  const opts = [5, 8, 10, 12.5, 15, 20];
  return opts.filter(o => o <= d + 0.05).pop() || 5;
}

async function loadLooks() {
  const r = await api('/api/presets').then(r => r.json());
  S.looks = r.looks;
  const box = $('looks'); box.innerHTML = '';
  r.looks.forEach((L, i) => {
    const b = document.createElement('button'); b.className = 'look' + (i === r.looks.length - 1 && r.looks.length % 2 ? ' wide' : ''); b.dataset.id = L.id;
    b.title = L.blurb;
    b.innerHTML = `<span class="sw" style="background:${L.swatch}"></span><span><div class="nm">${i + 1} · ${L.name}</div><div class="rl">${L.blurb.split(',')[0]}</div></span>`;
    b.onclick = () => applyLook(L.id);
    box.appendChild(b);
  });
}

// ------------------------------------------------------------------ sources
async function openFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.ply') || name.endsWith('.splat')) return openScan(await file.arrayBuffer(), file.name);
  const isVideo = file.type.startsWith('video') || /\.(mp4|mov|m4v|webm|mkv|avi|gif|wmv|mpe?g)$/.test(name);
  const detail = isVideo ? Math.min(Number(S.P.detail), 480) : Number(S.P.detail);
  const fd = new FormData(); fd.append('file', file); fd.append('detail', String(detail)); fd.append('seconds', '20');
  busy('Uploading ' + file.name, 0.02, '');
  try {
    const job = await api('/api/import', { method: 'POST', body: fd }).then(r => r.json());
    await waitJob(job);
  } catch (e) { busy(null); toast(e.message, { error: true }); }
}

async function waitJob(job) {
  let j = job;
  while (j.state !== 'done' && j.state !== 'error') {
    busy(`Making splats · ${j.name}`, j.progress, j.message);
    await new Promise(r => setTimeout(r, 350));
    j = await api('/api/job/' + j.id).then(r => r.json());
  }
  busy(null);
  if (j.state === 'error') throw new Error(j.error || 'Processing failed');
  await loadMedia(j.meta);
}

async function reprocess() {
  if (!S.media) return;
  try {
    const job = await postJSON('/api/reprocess', { media: S.media.id, detail: Number(S.P.detail) });
    await waitJob(job);
  } catch (e) { busy(null); toast(e.message, { error: true }); }
}

async function loadMedia(meta) {
  S.media = meta; S.scanName = null; S.frames.clear(); S.loading.clear(); S.builtIdx = -1; S.set = null;
  if (meta.kind === 'video') S.P.duration = videoDuration();
  S.time = 0; S.user = { yaw: 0, pitch: 0, zoom: 1 };
  $('empty').hidden = true;
  await getFrame(0);
  buildFrame(0);
  S.dirty = true;
  syncControls(); saveStateSoon();
  updateInfo();
}

function openScan(buf, name) {
  try {
    busy('Reading ' + name, 0.5, '');
    const set = parseScan(buf, name, true);
    S.media = null; S.scanName = name; S.frames.clear(); S.set = set; S.builtIdx = 0;
    R.setSplats(set);
    S.time = 0; S.user = { yaw: 0, pitch: 0, zoom: 1 };
    $('empty').hidden = true; S.dirty = true;
    syncControls(); updateInfo();
    toast(`Opened ${name}: ${set.count.toLocaleString()} splats`);
  } catch (e) { toast('Could not open the scan: ' + e.message, { error: true }); }
  busy(null);
}

function updateInfo() {
  const n = S.set ? (S.set.kind === 'depth' ? S.set.w * S.set.h : S.set.count) : 0;
  $('info').textContent = S.media ? `${S.media.name} · ${n.toLocaleString()} splats` : S.scanName ? `${S.scanName} · ${n.toLocaleString()} splats` : '';
}

async function getFrame(i) {
  if (!S.media) return null;
  i = ((i % S.media.frames) + S.media.frames) % S.media.frames;
  if (S.frames.has(i)) return S.frames.get(i);
  const id = S.media.id;
  const buf = await api(`/api/media/${id}/frame/${i}`).then(r => r.arrayBuffer());
  if (!S.media || S.media.id !== id) return null;
  const { width: w, height: h } = S.media;
  const fr = { w, h, rgba: new Uint8Array(buf, 0, w * h * 4), disp: new Uint16Array(buf, w * h * 4, w * h) };
  S.frames.set(i, fr);
  if (S.frames.size > 72) S.frames.delete(S.frames.keys().next().value);
  return fr;
}
function prefetch(from, n) {
  if (!S.media || S.media.kind !== 'video') return;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % S.media.frames;
    if (S.frames.has(i) || S.loading.has(i)) continue;
    S.loading.add(i);
    getFrame(i).catch(() => {}).finally(() => S.loading.delete(i));
  }
}
function buildOpts() {
  const P = S.P;
  return { matte: P.matte, cutoff: P.cutoff, depthCut: P.depthCut, feather: P.feather, relief: P.relief, edge: P.edge, fov: P.fov };
}
function buildFrame(i) {
  const fr = S.frames.get(i);
  if (!fr) return false;
  S.set = buildDepthSet(fr, buildOpts(), S.set);
  R.setSplats(S.set);
  S.builtIdx = i; S.needBuild = false; S.dirty = true;
  return true;
}
function frameIndexAt(t) {
  if (!S.media || S.media.kind !== 'video') return 0;
  return Math.floor(t * FPS + 1e-6) % S.media.frames;
}

// ------------------------------------------------------------------ view
function viewSize() {
  const wrap = $('viewWrap').getBoundingClientRect();
  const [ow, oh] = SIZES[S.aspect];
  const sc = Math.min(wrap.width / ow, wrap.height / oh);
  const cw = Math.max(64, Math.floor(ow * sc)), ch = Math.max(64, Math.floor(oh * sc));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const k = Math.min(1, 1080 / Math.max(cw * dpr, ch * dpr));
  return { cw, ch, pw: Math.round(cw * dpr * k), ph: Math.round(ch * dpr * k) };
}
function resize() {
  const c = $('view'), v = viewSize();
  c.style.width = v.cw + 'px'; c.style.height = v.ch + 'px';
  if (c.width !== v.pw || c.height !== v.ph) { c.width = v.pw; c.height = v.ph; }
  S.dirty = true;
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (S.exporting) return;
  const dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0; S.last = ts;
  const dur = S.P.duration;
  if (S.playing && S.set) { S.time = (S.time + dt) % dur; S.dirty = true; }
  if (S.media) {
    const want = frameIndexAt(S.time);
    if (S.media.kind === 'video') prefetch(want, 12);
    if ((want !== S.builtIdx || S.needBuild) && S.frames.has(want)) buildFrame(want);
  }
  if (!S.dirty || !S.set) { updateClock(); return; }
  const c = $('view');
  const cam = cameraFor(S.set, S.P, S.time / dur, S.user, c.width / c.height);
  const m = R.matrices(cam, c.width, c.height);
  const p = R.sort(m.view);
  if (p) p.then(() => { S.dirty = true; });
  R.draw(S.P, S.time, cam, c.width, c.height, false, transparent() ? 2 : 0);
  S.dirty = S.playing;
  updateClock();
}
function updateClock() {
  const dur = S.P.duration;
  $('clock').textContent = `${S.time.toFixed(1)} / ${dur} s`;
  if (!scrubbing) $('scrub').value = String(Math.round((S.time / dur) * 1000));
  $('btnPlay').textContent = S.playing ? '❚❚' : '▶';
}
let scrubbing = false;

// ------------------------------------------------------------------ export
function outSize() { return SIZES[S.aspect]; }

// 'mp4' (opaque H.264) or 'prores' (ProRes 4444 .mov with the background as transparency; PNGs keep it too)
function setFormat(f) {
  S.format = f === 'prores' ? 'prores' : 'mp4';
  $('exportFormat').value = S.format;
  $('btnExport').textContent = S.format === 'prores' ? 'Export ProRes' : 'Export MP4';
  S.dirty = true;
  saveStateSoon();
}

async function renderAt(t, w, h) {
  if (S.media) {
    const i = frameIndexAt(t);
    if (S.builtIdx !== i || S.needBuild) { await getFrame(i); buildFrame(i); }
  }
  const cam = cameraFor(S.set, S.P, t / S.P.duration, S.user, w / h);
  const m = R.matrices(cam, w, h);
  await R.sort(m.view, true);
  R.draw(S.P, t, cam, w, h, true, transparent() ? 1 : 0);
}

function baseName() {
  const src = S.media ? S.media.name.replace(/\.[^.]+$/, '') : S.scanName ? S.scanName.replace(/\.[^.]+$/, '') : 'splat';
  const look = S.looks.find(l => l.id === S.look)?.name || 'Custom';
  return `${src} - ${look}`;
}

async function exportMp4() {
  if (!S.set || S.exporting) return;
  const [w, h] = outSize(), dur = S.P.duration, frames = Math.round(dur * FPS);
  S.exporting = true; S.cancel = false;
  const wasPlaying = S.playing; S.playing = false;
  let id = null;
  const t0 = performance.now();
  try {
    const st = await postJSON('/api/export/start', { width: w, height: h, fps: FPS, frames, media: S.media?.id, name: baseName(), audio: true, format: S.format });
    id = st.id;
    let px = null;
    const T = { render: 0, read: 0, post: 0 };
    for (let i = 0; i < frames; i++) {
      if (S.cancel) throw new Error('cancelled');
      let a = performance.now();
      await renderAt(i / FPS, w, h);
      T.render += performance.now() - a; a = performance.now();
      px = R.readPixels(w, h, px);
      T.read += performance.now() - a; a = performance.now();
      await api(`/api/export/${id}/frame`, { method: 'POST', body: new Blob([px]) });
      T.post += performance.now() - a;
      const el = (performance.now() - t0) / 1000, left = el / (i + 1) * (frames - i - 1);
      busy(`Exporting ${transparent() ? 'ProRes 4444 (transparent)' : 'MP4'} · ${w}×${h}`, (i + 1) / frames, `Frame ${i + 1} of ${frames} · about ${Math.ceil(left)} s left`, () => { S.cancel = true; });
    }
    S.lastExportStats = { frames, seconds: (performance.now() - t0) / 1000, msPerFrame: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Math.round(v / frames)])) };
    busy('Exporting', 1, 'Finishing the file');
    const res = await postJSON(`/api/export/${id}/finish`, {});
    toast(`Saved ${res.path.split('\\').pop()} (${(res.bytes / 1e6).toFixed(1)} MB)`, { buttons: [['Show in folder', () => postJSON('/api/reveal', { path: res.path })]] });
    S.lastExport = res;
  } catch (e) {
    if (id) await postJSON(`/api/export/${id}/cancel`, {}).catch(() => {});
    if (e.message !== 'cancelled') toast('Export failed: ' + e.message, { error: true }); else toast('Export cancelled');
  } finally {
    busy(null); S.exporting = false; S.playing = wasPlaying; S.dirty = true; S.builtIdx = -1;
  }
}

async function savePng() {
  if (!S.set) return;
  const [w, h] = outSize();
  await renderAt(S.time, w, h);
  const px = R.readPixels(w, h);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const res = await api(`/api/save?ext=png&name=${encodeURIComponent(baseName() + ` - ${S.time.toFixed(1)}s`)}`, { method: 'POST', body: blob }).then(r => r.json());
  S.dirty = true; S.builtIdx = S.media?.kind === 'video' ? -1 : S.builtIdx;
  toast(`Saved ${res.path.split('\\').pop()}`, { buttons: [['Show in folder', () => postJSON('/api/reveal', { path: res.path })]] });
}

async function savePly() {
  if (!S.set) return;
  const bytes = writePly(S.set);
  const res = await api(`/api/save?ext=ply&name=${encodeURIComponent(baseName().split(' - ')[0] + ' - splats')}`, { method: 'POST', body: new Blob([bytes]) }).then(r => r.json());
  toast(`Saved ${res.path.split('\\').pop()} (${(res.bytes / 1e6).toFixed(1)} MB)`, { buttons: [['Show in folder', () => postJSON('/api/reveal', { path: res.path })]] });
}

// ------------------------------------------------------------------ recent / inbox
async function showRecent() {
  const box = $('recentList');
  if (!box.hidden) { box.hidden = true; return; }
  const { items } = await api('/api/media').then(r => r.json());
  box.innerHTML = items.length ? '' : '<div class="none">Nothing opened yet.</div>';
  for (const m of items) {
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = `<img src="${m.thumb}" alt=""><div><div>${m.name.replace(/</g, '&lt;')}</div><div class="small">${m.kind} · ${m.width}×${m.height}${m.kind === 'video' ? ' · ' + (m.frames / FPS).toFixed(1) + ' s' : ''} · detail ${m.detail}</div></div>`;
    d.onclick = async () => { box.hidden = true; await loadMedia(await api('/api/media/' + m.id).then(r => r.json())); };
    box.appendChild(d);
  }
  box.hidden = false;
}

async function pollInbox() {
  try {
    const r = await api('/api/inbox').then(r => r.json());
    for (const s of r.scans) openScan(await api('/api/scan-file?path=' + encodeURIComponent(s.path)).then(x => x.arrayBuffer()), s.name);
    for (const j of r.jobs) await waitJob(j).catch(e => toast(e.message, { error: true }));
  } catch (e) { /* server restarting */ }
  setTimeout(pollInbox, 1500);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('btnOpen').onclick = $('btnOpen2').onclick = () => $('fileMedia').click();
  $('btnScan').onclick = () => $('fileScan').click();
  $('fileMedia').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); };
  $('fileScan').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); };
  $('btnSample').onclick = async () => {
    try { const job = await postJSON('/api/sample', {}); await waitJob(job); } catch (e) { busy(null); toast(e.message, { error: true }); }
  };
  $('btnRecent').onclick = showRecent;
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) $('recentList').hidden = true; });
  $('btnExport').onclick = exportMp4;
  $('exportFormat').onchange = e => setFormat(e.target.value);
  $('btnPng').onclick = () => savePng().catch(e => toast(e.message, { error: true }));
  $('btnPly').onclick = () => savePly().catch(e => toast(e.message, { error: true }));
  $('btnFolder').onclick = () => postJSON('/api/reveal', {});
  $('btnPlay').onclick = () => { S.playing = !S.playing; S.dirty = true; };
  $('btnResetView').onclick = () => { S.user = { yaw: 0, pitch: 0, zoom: 1 }; S.dirty = true; };
  const sc = $('scrub');
  sc.oninput = () => { scrubbing = true; S.time = (Number(sc.value) / 1000) * S.P.duration * 0.9999; S.dirty = true; };
  sc.onchange = () => { scrubbing = false; };
  $('aspect').onchange = e => { S.aspect = e.target.value; resize(); saveStateSoon(); };
  window.addEventListener('resize', resize);

  // drag to look around, wheel to zoom
  const c = $('view'); let drag = null;
  c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw: S.user.yaw, pitch: S.user.pitch }; c.setPointerCapture(e.pointerId); c.classList.add('dragging'); });
  c.addEventListener('pointermove', e => {
    if (!drag) return;
    S.user.yaw = drag.yaw - (e.clientX - drag.x) * 0.006; S.user.pitch = drag.pitch + (e.clientY - drag.y) * 0.006; S.dirty = true;
  });
  c.addEventListener('pointerup', () => { drag = null; c.classList.remove('dragging'); });
  c.addEventListener('wheel', e => { e.preventDefault(); S.user.zoom = Math.min(6, Math.max(0.2, S.user.zoom * Math.exp(-e.deltaY * 0.0012))); S.dirty = true; }, { passive: false });
  c.addEventListener('dblclick', () => { S.user = { yaw: 0, pitch: 0, zoom: 1 }; S.dirty = true; });

  // drop files anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropHint').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); S.playing = !S.playing; S.dirty = true; }
    else if (e.key === 'r' || e.key === 'R') { S.user = { yaw: 0, pitch: 0, zoom: 1 }; S.dirty = true; }
    else if (e.key === 'e' || e.key === 'E') exportMp4();
    else if (e.key === 'o' || e.key === 'O') $('fileMedia').click();
    else if (/^[1-9]$/.test(e.key) && S.looks[Number(e.key) - 1]) applyLook(S.looks[Number(e.key) - 1].id);
    else if (e.key === 'Home') { S.time = 0; S.dirty = true; }
  });
}

async function main() {
  try { R = new Renderer($('view')); } catch (e) { toast(e.message, { error: true, ms: 60000 }); throw e; }
  window.SG = { S, R, applyLook, loadMedia, openScan, exportMp4, savePng, savePly, renderAt, setParam, setFormat };  // for tests
  await loadLooks();
  const st = loadState();
  if (st?.P) { S.P = { ...DEFAULTS, ...st.P }; S.look = st.look || null; S.aspect = SIZES[st.aspect] ? st.aspect : '1:1'; }
  else applyLook(S.looks[0].id);
  $('aspect').value = S.aspect;
  setFormat(st?.format === 'prores' ? 'prores' : 'mp4');
  // an older server still running (the app was updated while open) cannot write ProRes yet
  const ping = await api('/api/ping').then(r => r.json()).catch(() => ({}));
  if ((ping.version || 1) < 2) {
    $('exportFormat').querySelector('[value=prores]').disabled = true;
    setFormat('mp4');
    toast('Splat Garden was updated. Close this window and start Splat Garden again to get the new export options.', { ms: 600000 });
  }
  buildControls(); wire(); resize();
  requestAnimationFrame(frame);
  if (st?.media) {
    try { await loadMedia(await api('/api/media/' + st.media).then(r => r.json())); } catch (e) { /* cache was cleared */ }
  }
  pollInbox();
}
main();
