// Splat Garden renderer: 3D gaussian splats in WebGL2, the scan artifacts, and the post look.
//
// A "splat set" is what gets drawn. It comes from a processed photo/video frame (buildDepthSet: every pixel becomes
// a gaussian placed at its Depth Anything depth) or from a real scan (.ply / .splat, parseScan). Each splat is
// 8 uint32 in a RGBA32UI texture (2 texels):
//   [x, y, z as float bits, rgba8]  [cov xx|xy, cov xz|yy, cov yz|zz as half floats (x COV_SCALE), meta]
//   meta = kind (bits 0-1: 0 splat, 1 veil, 2 floater) | source row << 2 (14 bits) | source column << 16
// The effects (drips, veils, smear, swirl, felt, sphere crop...) are applied per splat in the vertex shader, so
// every slider is live. Splats are sorted back to front in sort-worker.js and blended over.

export const COV_SCALE = 4096;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ small helpers

const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function floatBits(v) { _f[0] = v; return _u[0]; }
export function toHalf(v) {
  if (v > 65000) v = 65000; else if (v < -65000) v = -65000;
  _f[0] = v; const x = _u[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return s * 65504;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
function hash32(i) {
  let x = (i ^ 61) ^ (i >>> 16); x = Math.imul(x, 9); x ^= x >>> 4; x = Math.imul(x, 0x27d4eb2d); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ building splats from a processed frame

// fr: {w, h, rgba: Uint8Array (A = AI cut-out), disp: Uint16Array (0 far .. 65535 near)}
// o:  {matte: 'ai'|'depth'|'both'|'none', cutoff, depthCut, feather, relief, edge, fov, veilDensity, floatDensity}
// A whole-scene build (matte 'none') also gets a backdrop: one big soft splat per BACK x BACK block, with the colour
// and depth of the block's farthest pixel, so places the camera sees behind things fill with background, not void.
export function buildDepthSet(fr, o, prev) {
  const { w, h, rgba, disp } = fr, n = w * h;
  const vd = o.veilDensity ?? 0.045, fd = o.floatDensity ?? 0.0025;
  const back = (o.matte || 'ai') === 'none';
  const BACK = 6, bw = Math.ceil(w / BACK), bh = Math.ceil(h / BACK);
  let s = prev;
  if (!s || s.kind !== 'depth' || s.w !== w || s.h !== h || s.vd !== vd || s.fd !== fd || s.back !== back) {
    const veil = [], flo = [];
    for (let i = 0; i < n; i++) {
      if (hash32(i * 3 + 1) < vd) veil.push(i);
      if (hash32(i * 7 + 5) < fd) flo.push(i);
    }
    const count = n + veil.length + flo.length + (back ? bw * bh : 0);
    s = { kind: 'depth', w, h, vd, fd, back, veil: Uint32Array.from(veil), flo: Uint32Array.from(flo), count,
          data: new Uint32Array(count * 8), pos: new Float32Array(count * 3), Z: new Float32Array(n),
          op: new Float32Array(n), srcEye: [0, 0, 0] };
  }
  const { data, pos, Z, op } = s;
  const matte = o.matte || 'ai';
  const fe = Math.max(0.01, o.feather ?? 0.08);
  // 1. opacity per pixel from the chosen matte
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255, d = disp[i] / 65535;
    let v = 1;
    const va = smooth((o.cutoff ?? 0.3) - fe, (o.cutoff ?? 0.3) + fe, a), vz = smooth((o.depthCut ?? 0.4) - fe, (o.depthCut ?? 0.4) + fe, d);
    if (matte === 'ai') v = va; else if (matte === 'depth') v = vz; else if (matte === 'both') v = Math.max(va, vz);
    op[i] = v;
  }
  // 2. depth range of what is kept (the subject's own depth, so a cut-out keeps its relief)
  let lo = 0, hi = 1;
  if (matte !== 'none') {
    const hist = new Uint32Array(1024); let tot = 0;
    for (let i = 0; i < n; i++) if (op[i] > 0.5) { hist[disp[i] >> 6]++; tot++; }
    if (tot > 50) {
      let acc = 0, a = -1, b = -1;
      for (let k = 0; k < 1024; k++) { acc += hist[k]; if (a < 0 && acc >= tot * 0.02) a = k; if (b < 0 && acc >= tot * 0.98) { b = k; break; } }
      lo = a / 1024; hi = Math.max(lo + 0.05, (b + 1) / 1024);
    }
  }
  const r = clamp(o.relief ?? 0.35, 0, 0.95);
  for (let i = 0; i < n; i++) {
    const dn = clamp((disp[i] / 65535 - lo) / (hi - lo), 0, 1);
    Z[i] = 1 / (1 - r + r * dn);
  }
  // 3. one gaussian per pixel, lying flat on the local surface (spanned by the steps to the neighbouring pixels).
  //    Across a depth jump those steps get long, so the splat stretches like a rubber sheet between foreground and
  //    background, which is where real splat scans tear. Edge stretch caps how far (in pixel footprints).
  const f = Math.max(w, h) / (2 * Math.tan((o.fov ?? 55) * DEG / 2)), invf = 1 / f;
  const cx = w / 2, cy = h / 2, k = 0.62, thin = 0.2, maxStretch = 1 + (o.edge ?? 2) * 3;
  let sw = 0, sx = 0, sy = 0, sz = 0;
  const uh = new Uint32Array(w), vh = new Uint32Array(h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u, z = Z[i];
      pos[i * 3] = (u + 0.5 - cx) * z * invf; pos[i * 3 + 1] = -(v + 0.5 - cy) * z * invf; pos[i * 3 + 2] = -z;
    }
  }
  const tu = [0, 0, 0], tv = [0, 0, 0];
  const step = (a, b, n, t, fp) => {  // per-pixel step from splat a to splat b, n pixels apart
    const s = n > 0 ? 1 / n : 0;
    t[0] = (pos[b * 3] - pos[a * 3]) * s; t[1] = (pos[b * 3 + 1] - pos[a * 3 + 1]) * s; t[2] = (pos[b * 3 + 2] - pos[a * 3 + 2]) * s;
    const l = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]), lim = fp * maxStretch;
    if (l > lim) { const q = lim / l; t[0] *= q; t[1] *= q; t[2] *= q; }
  };
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u, z = Z[i], fp = z * invf;
      const x = pos[i * 3], y = pos[i * 3 + 1];
      step(u > 0 ? i - 1 : i, u < w - 1 ? i + 1 : i, (u > 0) + (u < w - 1), tu, fp);
      step(v > 0 ? i - w : i, v < h - 1 ? i + w : i, (v > 0) + (v < h - 1), tv, fp);
      let nx = tu[1] * tv[2] - tu[2] * tv[1], ny = tu[2] * tv[0] - tu[0] * tv[2], nz = tu[0] * tv[1] - tu[1] * tv[0];
      let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) { nx = x; ny = y; nz = -z; nl = Math.sqrt(nx * nx + ny * ny + nz * nz); }
      nx /= nl; ny /= nl; nz /= nl;
      const kk = k * k * COV_SCALE, tt = (thin * fp) ** 2 * COV_SCALE;
      const cxx = kk * (tu[0] * tu[0] + tv[0] * tv[0]) + tt * nx * nx, cxy = kk * (tu[0] * tu[1] + tv[0] * tv[1]) + tt * nx * ny;
      const cxz = kk * (tu[0] * tu[2] + tv[0] * tv[2]) + tt * nx * nz, cyy = kk * (tu[1] * tu[1] + tv[1] * tv[1]) + tt * ny * ny;
      const cyz = kk * (tu[1] * tu[2] + tv[1] * tv[2]) + tt * ny * nz, czz = kk * (tu[2] * tu[2] + tv[2] * tv[2]) + tt * nz * nz;
      const j = i * 8;
      data[j] = floatBits(x); data[j + 1] = floatBits(y); data[j + 2] = floatBits(-z);
      const a8 = Math.round(op[i] * 255);
      data[j + 3] = (rgba[i * 4] | (rgba[i * 4 + 1] << 8) | (rgba[i * 4 + 2] << 16) | (a8 << 24)) >>> 0;
      data[j + 4] = (toHalf(cxx) | (toHalf(cxy) << 16)) >>> 0;
      data[j + 5] = (toHalf(cxz) | (toHalf(cyy) << 16)) >>> 0;
      data[j + 6] = (toHalf(cyz) | (toHalf(czz) << 16)) >>> 0;
      data[j + 7] = ((u << 16) | ((v & 0x3fff) << 2)) >>> 0;
      const wgt = op[i];
      if (wgt > 0.5) { sw += wgt; sx += x * wgt; sy += y * wgt; sz += z * wgt; uh[u]++; vh[v]++; }
    }
  }
  // 4. veils and floaters: copies of some pixels, flagged for the shader
  let at = n;
  for (const i of s.veil) { data.copyWithin(at * 8, i * 8, i * 8 + 8); pos.copyWithin(at * 3, i * 3, i * 3 + 3); data[at * 8 + 7] = (data[i * 8 + 7] | 1) >>> 0; at++; }
  for (const i of s.flo) {
    const kf = 0.3 + 0.5 * hash32(i * 13 + 2);
    const x = pos[i * 3] * (1 - kf), y = pos[i * 3 + 1] * (1 - kf), z = pos[i * 3 + 2] * (1 - kf);
    data.copyWithin(at * 8, i * 8, i * 8 + 8);
    data[at * 8] = floatBits(x); data[at * 8 + 1] = floatBits(y); data[at * 8 + 2] = floatBits(z);
    pos[at * 3] = x; pos[at * 3 + 1] = y; pos[at * 3 + 2] = z;
    data[at * 8 + 7] = (data[i * 8 + 7] | 2) >>> 0; at++;
  }
  if (back) {
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let best = -1, bd = 70000;
        for (let v = by * BACK; v < Math.min(h, by * BACK + BACK); v++) {
          for (let u = bx * BACK; u < Math.min(w, bx * BACK + BACK); u++) { const i = v * w + u; if (disp[i] < bd) { bd = disp[i]; best = i; } }
        }
        const z = Z[best] * 1.03, u = bx * BACK + BACK / 2, v = by * BACK + BACK / 2;
        const x = (u - cx) * z * invf, y = -(v - cy) * z * invf, sg = (BACK * 0.75 * z * invf) ** 2 * COV_SCALE;
        const j = at * 8;
        data[j] = floatBits(x); data[j + 1] = floatBits(y); data[j + 2] = floatBits(-z);
        data[j + 3] = ((rgba[best * 4] | (rgba[best * 4 + 1] << 8) | (rgba[best * 4 + 2] << 16) | (255 << 24)) >>> 0);
        data[j + 4] = (toHalf(sg)) >>> 0; data[j + 5] = (toHalf(sg) << 16) >>> 0; data[j + 6] = (toHalf(sg) << 16) >>> 0;
        data[j + 7] = (((Math.min(w - 1, u | 0)) << 16) | 3) >>> 0;
        pos[at * 3] = x; pos[at * 3 + 1] = y; pos[at * 3 + 2] = -z;
        at++;
      }
    }
  }
  // 5. framing info: where the kept subject sits and how deep
  const zp = sw > 0 ? sz / sw : 1 / (1 - r * 0.5);
  const pct = (hist, tot, q) => { let acc = 0; for (let k2 = 0; k2 < hist.length; k2++) { acc += hist[k2]; if (acc >= tot * q) return k2; } return hist.length - 1; };
  const tot = uh.reduce((a, b) => a + b, 0);
  let bb = [0, 0, w, h];
  if (tot > 50) bb = [pct(uh, tot, 0.005), pct(vh, tot, 0.005), pct(uh, tot, 0.995) + 1, pct(vh, tot, 0.995) + 1];
  s.pivot = sw > 0 ? [sx / sw, sy / sw, -zp] : [0, 0, -zp];
  s.zp = zp; s.invf = invf; s.cx = cx; s.cy = cy; s.bbox = bb; s.coverage = tot / n;
  s.radius = Math.max(0.05, Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 * invf * zp);
  if (matte === 'none') s.radius = Math.max(w, h) * 0.5 * invf * zp;
  s.version = (s.version || 0) + 1;
  return s;
}

// ------------------------------------------------------------------ real scans (.ply from Polycam / Luma / Postshot / Inria, .splat)

export function parseScan(buf, name, flip = true) {
  const lower = (name || '').toLowerCase();
  const raw = lower.endsWith('.splat') ? readDotSplat(buf) : readPly(buf);
  return scanSet(raw, flip);
}

function readPly(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536)));
  const end = head.indexOf('end_header');
  if (!head.startsWith('ply') || end < 0) throw new Error('Not a PLY file');
  const lines = head.slice(0, end).split(/\r?\n/);
  if (!lines.some(l => l.startsWith('format binary_little_endian'))) throw new Error('Only binary little-endian PLY scans are supported');
  let n = 0, inVertex = false, stride = 0; const props = {};
  const size = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4 };
  let beforeVertex = 0;
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') {
      inVertex = t[1] === 'vertex';
      if (inVertex) n = parseInt(t[2], 10);
      else if (n === 0) throw new Error('PLY elements before the vertices are not supported');
    } else if (t[0] === 'property' && inVertex) {
      if (t[1] === 'list') throw new Error('PLY with list properties on vertices is not supported');
      props[t[2]] = { off: stride, type: t[1] }; stride += size[t[1]] || 4;
    }
  }
  const start = head.indexOf('\n', end) + 1 + beforeVertex;
  const dv = new DataView(buf, start);
  const get = (p, i) => {
    const o = i * stride + p.off;
    switch (p.type) {
      case 'double': case 'float64': return dv.getFloat64(o, true);
      case 'uchar': case 'uint8': return dv.getUint8(o);
      case 'ushort': case 'uint16': return dv.getUint16(o, true);
      case 'short': case 'int16': return dv.getInt16(o, true);
      case 'int': case 'int32': return dv.getInt32(o, true);
      case 'uint': case 'uint32': return dv.getUint32(o, true);
      default: return dv.getFloat32(o, true);
    }
  };
  if (!props.x) throw new Error('This PLY has no x/y/z positions');
  if (start + n * stride > buf.byteLength) throw new Error('This PLY file is cut short');
  const P = new Float32Array(n * 3), C = new Float32Array(n * 6), RGBA = new Uint8Array(n * 4);
  const gs = props.scale_0 && props.rot_0;
  const sh = props.f_dc_0, rgb = props.red;
  for (let i = 0; i < n; i++) {
    P[i * 3] = get(props.x, i); P[i * 3 + 1] = get(props.y, i); P[i * 3 + 2] = get(props.z, i);
    let r = 0.6, g = 0.6, b = 0.6, a = 1;
    if (sh) { const k = 0.28209479177387814; r = 0.5 + k * get(props.f_dc_0, i); g = 0.5 + k * get(props.f_dc_1, i); b = 0.5 + k * get(props.f_dc_2, i); }
    else if (rgb) { r = get(props.red, i) / 255; g = get(props.green, i) / 255; b = get(props.blue, i) / 255; }
    if (props.opacity) a = 1 / (1 + Math.exp(-get(props.opacity, i)));
    RGBA[i * 4] = clamp(r * 255, 0, 255); RGBA[i * 4 + 1] = clamp(g * 255, 0, 255); RGBA[i * 4 + 2] = clamp(b * 255, 0, 255); RGBA[i * 4 + 3] = clamp(a * 255, 0, 255);
    if (gs) {
      covFrom([Math.exp(get(props.scale_0, i)), Math.exp(get(props.scale_1, i)), Math.exp(get(props.scale_2, i))],
              [get(props.rot_0, i), get(props.rot_1, i), get(props.rot_2, i), get(props.rot_3, i)], C, i * 6);
    } else C[i * 6] = C[i * 6 + 3] = C[i * 6 + 5] = -1;  // plain point cloud: size decided later
  }
  return { n, P, C, RGBA };
}

function readDotSplat(buf) {
  const n = Math.floor(buf.byteLength / 32);
  const f = new Float32Array(buf, 0, n * 8), u = new Uint8Array(buf);
  const P = new Float32Array(n * 3), C = new Float32Array(n * 6), RGBA = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    P[i * 3] = f[i * 8]; P[i * 3 + 1] = f[i * 8 + 1]; P[i * 3 + 2] = f[i * 8 + 2];
    for (let c = 0; c < 4; c++) RGBA[i * 4 + c] = u[i * 32 + 24 + c];
    const q = [0, 1, 2, 3].map(c => (u[i * 32 + 28 + c] - 128) / 128);
    covFrom([f[i * 8 + 3], f[i * 8 + 4], f[i * 8 + 5]], q, C, i * 6);
  }
  return { n, P, C, RGBA };
}

function covFrom(sc, q, C, o) {
  let [w, x, y, z] = q; const l = Math.hypot(w, x, y, z) || 1; w /= l; x /= l; y /= l; z /= l;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
             2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
             2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const M = [R[0] * sc[0], R[1] * sc[1], R[2] * sc[2], R[3] * sc[0], R[4] * sc[1], R[5] * sc[2], R[6] * sc[0], R[7] * sc[1], R[8] * sc[2]];
  C[o] = M[0] * M[0] + M[1] * M[1] + M[2] * M[2];
  C[o + 1] = M[0] * M[3] + M[1] * M[4] + M[2] * M[5];
  C[o + 2] = M[0] * M[6] + M[1] * M[7] + M[2] * M[8];
  C[o + 3] = M[3] * M[3] + M[4] * M[4] + M[5] * M[5];
  C[o + 4] = M[3] * M[6] + M[4] * M[7] + M[5] * M[8];
  C[o + 5] = M[6] * M[6] + M[7] * M[7] + M[8] * M[8];
}

function scanSet(raw, flip) {
  const { n, P, C, RGBA } = raw;
  if (!n) throw new Error('This scan has no splats');
  // centre on the median, scale so the bulk of the scan has radius 1
  const sample = Math.max(1, Math.floor(n / 20000)), xs = [], ys = [], zs = [];
  for (let i = 0; i < n; i += sample) { xs.push(P[i * 3]); ys.push(P[i * 3 + 1]); zs.push(P[i * 3 + 2]); }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const c = [med(xs), med(ys), med(zs)];
  const ds = [];
  for (let i = 0; i < n; i += sample) ds.push(Math.hypot(P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]));
  ds.sort((p, q) => p - q);
  const rad = ds[Math.floor(ds.length * 0.8)] || 1, s = 1 / rad, fy = flip ? -1 : 1;
  const count = n, data = new Uint32Array(count * 8), pos = new Float32Array(count * 3);
  const ptSize = 0.004;
  for (let i = 0; i < n; i++) {
    const x = (P[i * 3] - c[0]) * s, y = (P[i * 3 + 1] - c[1]) * s * fy, z = (P[i * 3 + 2] - c[2]) * s * fy;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const j = i * 8, k = i * 6, s2 = s * s * COV_SCALE;
    let cxx = C[k], cxy = C[k + 1], cxz = C[k + 2], cyy = C[k + 3], cyz = C[k + 4], czz = C[k + 5];
    if (cxx < 0) { cxx = cyy = czz = ptSize * ptSize / (s * s); cxy = cxz = cyz = 0; }
    data[j] = floatBits(x); data[j + 1] = floatBits(y); data[j + 2] = floatBits(z);
    data[j + 3] = (RGBA[i * 4] | (RGBA[i * 4 + 1] << 8) | (RGBA[i * 4 + 2] << 16) | (RGBA[i * 4 + 3] << 24)) >>> 0;
    data[j + 4] = (toHalf(cxx * s2) | (toHalf(cxy * s2 * fy) << 16)) >>> 0;
    data[j + 5] = (toHalf(cxz * s2 * fy) | (toHalf(cyy * s2) << 16)) >>> 0;
    data[j + 6] = (toHalf(cyz * s2) | (toHalf(czz * s2) << 16)) >>> 0;
    const col = clamp(Math.floor((x + 2) * 256), 0, 65535), row = clamp(Math.floor((2 - y) * 256), 0, 16383);
    data[j + 7] = ((col << 16) | (row << 2)) >>> 0;
  }
  return { kind: 'scan', count, n, data, pos, pivot: [0, 0, 0], radius: 1, zp: 2.6, srcEye: [0, 0, 2.6], version: 1 };
}

// ------------------------------------------------------------------ writing a .ply (3DGS layout, Y-down like most scan tools)

export function writePly(set) {
  const n = set.kind === 'depth' ? set.w * set.h : set.count, d = set.data;
  const keep = [];
  for (let i = 0; i < n; i++) if ((d[i * 8 + 3] >>> 24) > 8) keep.push(i);
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\ncomment Splat Garden\nelement vertex ${keep.length}\n` +
    props.map(p => `property float ${p}`).join('\n') + '\nend_header\n';
  const hb = new TextEncoder().encode(header);
  const f = new Float32Array(keep.length * props.length);  // the header length is arbitrary, so fill floats apart
  const K = 0.28209479177387814;
  keep.forEach((i, r) => {
    const j = i * 8, o = r * props.length;
    _u[0] = d[j]; const x = _f[0]; _u[0] = d[j + 1]; const y = _f[0]; _u[0] = d[j + 2]; const z = _f[0];
    const c = d[j + 3];
    const h = k => fromHalf(k) / COV_SCALE;
    const cov = [h(d[j + 4] & 0xffff), h(d[j + 4] >>> 16), h(d[j + 5] & 0xffff), h(d[j + 5] >>> 16), h(d[j + 6] & 0xffff), h(d[j + 6] >>> 16)];
    // flip to Y-down: y -> -y, z -> -z (xy and xz terms change sign)
    const { vals, vecs } = eigSym3([cov[0], -cov[1], -cov[2], cov[3], cov[4], cov[5]]);
    const q = quatFromCols(vecs);
    f[o] = x; f[o + 1] = -y; f[o + 2] = -z;
    f[o + 6] = ((c & 255) / 255 - 0.5) / K; f[o + 7] = (((c >>> 8) & 255) / 255 - 0.5) / K; f[o + 8] = (((c >>> 16) & 255) / 255 - 0.5) / K;
    const a = clamp((c >>> 24) / 255, 0.002, 0.998); f[o + 9] = Math.log(a / (1 - a));
    for (let k = 0; k < 3; k++) f[o + 10 + k] = Math.log(Math.sqrt(Math.max(vals[k], 1e-14)));
    f[o + 13] = q[0]; f[o + 14] = q[1]; f[o + 15] = q[2]; f[o + 16] = q[3];
  });
  const out = new Uint8Array(hb.length + f.byteLength);
  out.set(hb, 0);
  out.set(new Uint8Array(f.buffer), hb.length);
  return out;
}

function eigSym3(c) {  // Jacobi rotations on [xx, xy, xz, yy, yz, zz]; eigenvectors as columns of V (row-major 3x3)
  const A = [[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 8; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-20) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
    }
  }
  // right-handed
  const det = V[0][0] * (V[1][1] * V[2][2] - V[1][2] * V[2][1]) - V[0][1] * (V[1][0] * V[2][2] - V[1][2] * V[2][0]) + V[0][2] * (V[1][0] * V[2][1] - V[1][1] * V[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) V[k][2] = -V[k][2];
  return { vals: [A[0][0], A[1][1], A[2][2]], vecs: V };
}

function quatFromCols(m) {  // rotation matrix (row-major) -> [w, x, y, z]
  const tr = m[0][0] + m[1][1] + m[2][2];
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s; }
  return [w, x, y, z];
}

// ------------------------------------------------------------------ camera

const ease = u => u * u * (3 - 2 * u);

function baseFraming(set, aspect, frame) {
  if (set.kind !== 'depth') return { target: [0, 0, 0], dist: 2.6, tanY: Math.tan(24 * DEG) };
  const { w, h, invf, cx, cy, zp, bbox } = set;
  if (frame === 'subject' && set.coverage > 0.002) {
    const bu = (bbox[0] + bbox[2]) / 2, bv = (bbox[1] + bbox[3]) / 2;
    const tx = (bbox[2] - bbox[0]) / 2 * invf * 1.42, ty = (bbox[3] - bbox[1]) / 2 * invf * 1.42;
    return { target: [(bu - cx) * invf * zp, -(bv - cy) * invf * zp, -zp], dist: zp, tanY: Math.max(ty, tx / aspect) };
  }
  const hw = w / 2 * invf, hh = h / 2 * invf;
  return { target: [0, 0, -zp], dist: zp, tanY: Math.min(hh, hw / aspect) };
}

// P: look params; u: 0..1 through the clip; user: {yaw, pitch, zoom} from dragging in the window
export function cameraFor(set, P, u, user, aspect) {
  const b = baseFraming(set, aspect, P.frame);
  const A = P.amount * DEG, T = P.tilt * DEG, D = P.dolly, c = P.cycles, tau = Math.PI * 2;
  let yaw = 0, pitch = P.pitch * DEG, dist = 1, roll = 0;
  switch (P.motion) {
    case 'orbit':
      yaw = A * Math.sin(tau * c * u); pitch += T * Math.sin(tau * c * u * 2) * 0.5;
      dist = 1 - D * 0.5 * (1 - Math.cos(tau * c * u)); break;
    case 'sweep': {
      const e = ease(u); yaw = A * (2 * e - 1); pitch += T * (2 * e - 1) * 0.5; dist = 1 - D * Math.sin(Math.PI * u); break;
    }
    case 'fly':
      yaw = A * Math.sin(tau * c * u); pitch += T * Math.sin(tau * c * u + 1.1);
      dist = 1 - D * (0.5 - 0.5 * Math.cos(tau * c * u)); roll = P.roll * DEG * Math.sin(tau * c * u + 0.6); break;
    case 'push': {
      const e = ease(u); dist = 1 - D * e; yaw = A * (e - 0.5); pitch += T * Math.sin(Math.PI * u) * 0.5; break;
    }
    case 'drift':
      yaw = A * (0.7 * Math.sin(tau * c * u) + 0.3 * Math.sin(tau * 2 * c * u + 0.4));
      pitch += T * Math.sin(tau * c * u + 2.0) * 0.5; dist = 1 - D * 0.5 * (1 - Math.cos(tau * c * u)); break;
    default: break;
  }
  if (P.motion !== 'fly') roll = P.roll * DEG * Math.sin(Math.PI * 2 * c * u) * 0.5;
  yaw += (user?.yaw || 0); pitch += (user?.pitch || 0);
  pitch = clamp(pitch, -80 * DEG, 80 * DEG);
  const d = b.dist * dist, t = b.target;
  const eye = [t[0] + d * Math.sin(yaw) * Math.cos(pitch), t[1] + d * Math.sin(pitch), t[2] + d * Math.cos(yaw) * Math.cos(pitch)];
  const tanY = b.tanY / Math.max(0.05, P.zoom * (user?.zoom || 1));
  return { eye, target: t, roll, fovY: 2 * Math.atan(tanY), near: d * 0.02, far: d * 60 + 10 };
}

function lookAt(eye, t, roll) {
  let zx = eye[0] - t[0], zy = eye[1] - t[1], zz = eye[2] - t[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy = 0, xz = -zx;  // cross((0,1,0), z)
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  let yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  if (roll) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const nx = [c * xx + s * yx, c * xy + s * yy, c * xz + s * yz], ny = [-s * xx + c * yx, -s * xy + c * yy, -s * xz + c * yz];
    [xx, xy, xz] = nx; [yx, yy, yz] = ny;
  }
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
}

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

// ------------------------------------------------------------------ shaders

const SPLAT_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uData;
uniform mat4 uView, uProj;
uniform vec2 uViewport, uFocal;
uniform float uTime, uRadius;
uniform vec3 uPivot, uSrcEye;
uniform float uInvf;
uniform float uScale, uOpacity, uJitter, uFuzz, uFuzzLen;
uniform float uDrip, uDripLen, uDripWidth, uDripDir, uDripSpeed, uDripStart;
uniform vec2 uRowRange;
uniform float uVeil, uVeilLen, uFloat, uFloatSize, uFill;
uniform float uSmear, uSmearLen, uSmearAngle;
uniform float uSwirl, uSwirlRadius; uniform vec2 uSwirlCenter;
uniform float uSphere, uSphereRadius, uSphereSoft, uSphereSquash;
in vec2 aCorner;
in uint aIndex;
out vec4 vColor; out vec2 vPos; out float vHard;
uint hu(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float hf(uint x) { return float(hu(x) >> 8u) / 16777216.0; }
void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vColor = vec4(0.0); vPos = vec2(0.0); vHard = 0.0; }
void main() {
  uint idx = aIndex;
  ivec2 tc = ivec2(int((idx & 1023u) << 1u), int(idx >> 10u));
  uvec4 t0 = texelFetch(uData, tc, 0);
  uvec4 t1 = texelFetch(uData, tc + ivec2(1, 0), 0);
  vec3 p = uintBitsToFloat(t0.xyz);
  vec4 col = vec4(float(t0.w & 255u), float((t0.w >> 8u) & 255u), float((t0.w >> 16u) & 255u), float(t0.w >> 24u)) / 255.0;
  vec2 a = unpackHalf2x16(t1.x), b = unpackHalf2x16(t1.y), c = unpackHalf2x16(t1.z);
  mat3 V = mat3(a.x, a.y, b.x, a.y, b.y, c.x, b.x, c.x, c.y) * (1.0 / ${COV_SCALE.toFixed(1)});
  uint meta = t1.w, kind = meta & 3u;
  float column = float(meta >> 16u), row = float((meta >> 2u) & 16383u);
  float r1 = hf(idx * 3u + 1u), r2 = hf(idx * 7u + 2u), r3 = hf(idx * 11u + 3u), r4 = hf(idx * 13u + 4u);
  float R = uRadius;
  vHard = 0.0;
  if (col.a < 0.004) { cull(); return; }
  V *= uScale * uScale;
  float s = sqrt(max(1e-14, (V[0][0] + V[1][1] + V[2][2]) / 3.0));
  vec3 ray = normalize(p - uSrcEye + vec3(0.0, 0.0, 1e-6));
  // one source pixel's footprint: streak splats are rebuilt this thin so they stay crisp lines
  float fp = uInvf > 0.0 ? length(p - uSrcEye) * uInvf * 0.62 * uScale : sqrt(max(1e-14, min(V[0][0], min(V[1][1], V[2][2]))));
  // depth fuzz: splats scattered along their view ray
  p += ray * (r2 - 0.5) * uJitter * s * 16.0;
  // felt: thin needles in random directions
  if (uFuzz > 0.0) {
    vec3 dir = normalize(vec3(r1 * 2.0 - 1.0, r3 * 2.0 - 1.0, (r4 * 2.0 - 1.0) * 0.4) + 1e-4);
    float L = s * uFuzzLen * (0.4 + 1.2 * r2);
    V = V * (1.0 - 0.7 * uFuzz) + (uFuzz * L * L) * outerProduct(dir, dir);
  }
  // swirl: a vortex in the picture plane, smearing what it turns
  if (uSwirl != 0.0) {
    vec2 c0 = uPivot.xy + uSwirlCenter * R;
    vec2 d = p.xy - c0; float r = length(d);
    float k = 1.0 - smoothstep(0.0, max(1e-3, uSwirlRadius * R), r);
    float ang = uSwirl * k * k;
    float cs = cos(ang), sn = sin(ang);
    p.xy = c0 + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
    if (r > 1e-5) {
      vec3 tg = normalize(vec3(-(p.y - c0.y), p.x - c0.x, 0.0));
      float L = abs(ang) * r * 0.3 * (0.5 + r1);
      V += L * L * outerProduct(tg, tg);
    }
  }
  // smear: some splats pulled into streaks
  if (uSmear > 0.0 && r3 < uSmear) {
    float ang = uSmearAngle + (r1 - 0.5) * 0.8;
    vec3 dir = vec3(cos(ang), sin(ang), 0.0);
    float L = uSmearLen * R * 0.18 * r2 * r2;
    p += dir * L * (r4 - 0.5);
    V = mat3(fp * fp) + L * L * outerProduct(dir, dir) * 0.35;
  }
  // drips: whole columns stretched into vertical streaks
  if (uDrip > 0.0 && kind == 0u) {
    float sid = floor(column / max(1.0, uDripWidth));
    uint su = uint(sid);
    float hs = hf(su * 7919u + 13u), ph = hf(su * 104729u + 7u);
    float n = 0.5 + 0.5 * sin(6.2831853 * (uTime * uDripSpeed * (0.3 + 0.7 * hs) + ph));
    float rowN = (row - uRowRange.x) / max(1.0, uRowRange.y - uRowRange.x);
    if (hs < uDrip * 0.55 && r4 < 0.75 && rowN >= uDripStart) {
      float dir = uDripDir;
      if (dir == 0.0) dir = hf(su * 31u + 5u) < 0.68 ? -1.0 : 1.0;
      float L = uDripLen * R * 0.6 * (0.15 + 0.85 * hf(su * 17u + 3u)) * (0.3 + 0.7 * n) * (0.35 + 0.65 * r1);
      p.y += dir * L * 0.5;
      V = mat3(fp * fp);
      V[1][1] += (L * 0.3) * (L * 0.3);
      vHard = 1.0;
    }
  }
  // veils: pale upward haze off the tops of things
  if (kind == 1u) {
    if (uVeil <= 0.0) { cull(); return; }
    float L = uVeilLen * R * 0.5 * (0.25 + 0.75 * r2);
    p.y += L * 0.6;
    V = mat3(fp * fp * (4.0 + 12.0 * r1));
    V[1][1] += (L * 0.4) * (L * 0.4);
    col.rgb = mix(col.rgb, vec3(0.8, 0.88, 1.0), 0.5);
    col.a *= uVeil * 0.13;
  }
  // floaters: big soft blobs hanging in front of the scan
  if (kind == 2u) {
    if (uFloat <= 0.0) { cull(); return; }
    float g = uFloatSize * (6.0 + 22.0 * r1);
    V = mat3(fp * fp * g * g);
    col.rgb *= 0.5 + 0.35 * r3;
    col.a *= uFloat * 0.55;
  }
  // backdrop (whole-scene builds): soft background that fills what the camera sees behind things
  if (kind == 3u) col.a *= uFill;
  // sphere crop: the scan's bounding ball with a soft edge
  if (uSphere > 0.0) {
    vec3 q = (p - uPivot) / max(1e-3, uSphereRadius * R);
    q.y /= max(0.1, uSphereSquash);
    col.a *= 1.0 - uSphere * smoothstep(1.0 - max(0.02, uSphereSoft), 1.0, length(q));
  }
  col.a *= uOpacity;
  if (col.a < 0.004) { cull(); return; }

  vec4 cam = uView * vec4(p, 1.0);
  if (cam.z > -1e-3) { cull(); return; }
  vec4 clip = uProj * cam;
  vec2 ndc = clip.xy / clip.w;
  if (abs(ndc.x) > 1.6 || abs(ndc.y) > 1.6) { cull(); return; }
  mat3 Rv = mat3(uView);
  mat3 Vc = Rv * V * transpose(Rv);
  float zc = -cam.z;
  mat3 J = mat3(uFocal.x / zc, 0.0, 0.0, 0.0, uFocal.y / zc, 0.0, uFocal.x * cam.x / (zc * zc), uFocal.y * cam.y / (zc * zc), 0.0);
  mat3 C2 = J * Vc * transpose(J);
  float cxx = C2[0][0] + 0.3, cxy = C2[0][1], cyy = C2[1][1] + 0.3;
  float mid = 0.5 * (cxx + cyy), rad = length(vec2(0.5 * (cxx - cyy), cxy));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 dv = abs(cxy) > 1e-9 ? normalize(vec2(cxy, l1 - cxx)) : (cxx >= cyy ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 ax1 = min(sqrt(2.0 * l1), 2048.0) * dv;
  vec2 ax2 = min(sqrt(2.0 * l2), 2048.0) * vec2(dv.y, -dv.x);
  vColor = vec4(col.rgb, min(col.a, 0.995));
  vPos = aCorner;
  gl_Position = vec4(ndc + (aCorner.x * ax1 + aCorner.y * ax2) * 2.0 / uViewport, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 vColor; in vec2 vPos; in float vHard;
out vec4 o;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  // drips are flat bars with a crisp edge; everything else is a plain gaussian
  float B = (vHard > 0.5 ? 1.0 - smoothstep(0.5, 0.75, -A / 4.0) : exp(A)) * vColor.a;
  if (B < 0.002) discard;
  o = vec4(vColor.rgb * B, B);
}`;

const POST_VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const POST_FS = `#version 300 es
precision highp float;
uniform sampler2D uLayer;
uniform vec2 uRes;
uniform float uTime, uSeed;
uniform vec3 uBg, uTint;
uniform float uExposure, uContrast, uSat, uBlacks, uLift, uWarm, uTintAmt;
uniform float uSoften, uGlow, uGrain, uVignette;
uniform float uBlocks, uBlockSize, uBlockRate, uBlockShift, uStretch, uStretchSize;
uniform int uMode;  // 0 opaque over uBg, 1 transparent (straight alpha), 2 transparent previewed over a checkerboard
in vec2 vUv; out vec4 o;
float h2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 grade(vec3 c) {
  c *= uExposure;
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);
  c = max(c - uBlacks, 0.0) / max(1.0 - uBlacks, 0.05);
  c = c * (1.0 - uLift) + uLift;
  c *= vec3(1.0 + 0.12 * uWarm, 1.0 + 0.02 * uWarm, 1.0 - 0.14 * uWarm);
  c = mix(c, uTint * (0.35 + 1.1 * l), uTintAmt);
  return clamp(c, 0.0, 1.0);
}
void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  float stepT = floor(uTime * max(0.001, uBlockRate)) + uSeed;
  // pixel stretch: in some blocks every column repeats its top pixel downwards
  if (uStretch > 0.0) {
    vec2 cells = vec2(10.0 * aspect, 7.0) / max(0.2, uStretchSize);
    vec2 cell = floor(uv * cells);
    if (h2(cell + stepT * 1.37 + 3.1) < uStretch * 0.32 && textureLod(uLayer, (cell + 0.5) / cells, 4.0).a > 0.05)
      uv.y = (cell.y + 1.0) / cells.y - 0.5 / uRes.y;
  }
  vec4 L = textureLod(uLayer, uv, 0.0);
  vec4 B1 = textureLod(uLayer, uv, 1.6), B2 = textureLod(uLayer, uv, 4.0);
  L = mix(L, B1, uSoften);
  // everything below is premultiplied (P.rgb already times P.a); the background is only added at the very end
  vec4 P = vec4((L.a > 0.0005 ? grade(L.rgb / L.a) : vec3(0.0)) * L.a, L.a);
  vec4 G = vec4(0.0);
  if (uGlow > 0.0) G = vec4(B2.a > 0.0005 ? grade(B2.rgb / B2.a) * B2.a : vec3(0.0), B2.a) * uGlow * 0.6;
  // glitch blocks: tinted rectangles over the subject, some showing shifted content
  if (uBlocks > 0.0) {
    for (int k = 0; k < 2; k++) {
      float sz = uBlockSize * (k == 0 ? 1.0 : 1.9);
      vec2 cells = vec2(18.0 * aspect, 18.0) / max(0.2, sz) * vec2(1.0, k == 0 ? 1.35 : 0.8);
      vec2 cell = floor(uv * cells + vec2(h2(vec2(float(k), stepT)), h2(vec2(stepT, float(k) + 7.0))));
      if (h2(cell + stepT * 0.731 + float(k) * 17.0) < uBlocks * 0.09) {
        vec2 cc = (cell + 0.5 - vec2(h2(vec2(float(k), stepT)), h2(vec2(stepT, float(k) + 7.0)))) / cells;
        if (textureLod(uLayer, cc, 4.5).a > 0.15) {
          vec2 sh = (vec2(h2(cell + 3.0), h2(cell + 9.0)) - 0.5) * uBlockShift / cells;
          vec4 S = textureLod(uLayer, uv + sh, 0.0);
          vec4 SP = vec4((S.a > 0.0005 ? grade(S.rgb / S.a) : vec3(0.0)) * S.a, S.a);
          float pick = h2(cell + 21.0 + stepT);
          vec3 tint = pick < 0.5 ? vec3(0.97, 0.56, 0.8) : (pick < 0.82 ? vec3(0.92, 0.13, 0.08) : vec3(0.74, 0.64, 1.0));
          P = mix(SP, vec4(tint, 1.0), 0.5);  // over a background this is exactly mix(content, tint, 0.5)
          G = vec4(0.0);
        }
      }
    }
  }
  float grain = uGrain > 0.0 ? (h2(gl_FragCoord.xy + fract(uTime * 7.31) * 913.0) - 0.5) * uGrain : 0.0;
  float vig = 1.0;
  if (uVignette > 0.0) {
    vec2 q = (vUv - 0.5) * vec2(aspect, 1.0) / max(aspect, 1.0);
    vig = 1.0 - uVignette * smoothstep(0.25, 0.85, length(q) * 1.2);
  }
  if (uMode == 0) {  // opaque: over the background colour
    vec3 col = P.rgb + uBg * (1.0 - P.a) + G.rgb;
    col += grain * (0.3 + 0.7 * L.a);
    o = vec4(clamp(col * vig, 0.0, 1.0), 1.0);
    return;
  }
  // transparent: the background becomes alpha; glow adds light and coverage, grain and vignette touch the subject only
  P = vec4(P.rgb + G.rgb, min(1.0, P.a + G.a));
  P.rgb = (P.rgb + grain * P.a) * vig;
  if (uMode == 1) {  // export: straight (unpremultiplied) colour + alpha, as ProRes 4444 / PNG expect
    o = vec4(P.a > 0.0005 ? clamp(P.rgb / P.a, 0.0, 1.0) : vec3(0.0), clamp(P.a, 0.0, 1.0));
    return;
  }
  // preview: over a checkerboard, like an editor's transparency grid
  float ck = mod(floor(gl_FragCoord.x / 12.0) + floor(gl_FragCoord.y / 12.0), 2.0);
  vec3 board = mix(vec3(0.16, 0.17, 0.2), vec3(0.24, 0.25, 0.29), ck);
  o = vec4(clamp(P.rgb + board * (1.0 - clamp(P.a, 0.0, 1.0)), 0.0, 1.0), 1.0);
}`;

// ------------------------------------------------------------------ renderer

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n').slice(0, 4000));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

export function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0x0035ff;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser cannot render to float textures');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.splat = compile(gl, SPLAT_VS, SPLAT_FS);
    this.post = compile(gl, POST_VS, POST_FS);
    // splat VAO: quad corners + per-instance index
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, -2, 2, 2, 2]), gl.STATIC_DRAW);
    const la = gl.getAttribLocation(this.splat.p, 'aCorner'); gl.enableVertexAttribArray(la); gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 0, 0);
    this.indexBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    const li = gl.getAttribLocation(this.splat.p, 'aIndex'); gl.enableVertexAttribArray(li);
    gl.vertexAttribIPointer(li, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(li, 1);
    gl.bindVertexArray(null);
    // post VAO
    this.pvao = gl.createVertexArray(); gl.bindVertexArray(this.pvao);
    const tri = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(this.post.p, 'aPos'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.dataTex = gl.createTexture();
    this.texRows = 0;
    this.layer = null;
    this.out = null;
    this.set = null;
    this.orderCount = 0;
    this.sortId = 0;
    this.pending = null;
    this.lastSortKey = '';
    this.worker = new Worker('/static/sort-worker.js');
    this.waiters = new Map();
    this.worker.onmessage = (e) => this._onSorted(e.data);
  }

  // Upload a splat set (or the same set object after a rebuild). Keeps the current order when the count is unchanged.
  setSplats(set) {
    const gl = this.gl;
    const rows = Math.ceil(set.count / 1024);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    const view = set.data.length === rows * 1024 * 8 ? set.data : (() => { const a = new Uint32Array(rows * 1024 * 8); a.set(set.data); return a; })();
    if (rows !== this.texRows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, view);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.texRows = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, view);
    }
    if (!this.set || this.set.count !== set.count) this.orderCount = 0;
    this.set = set;
    this.setVersion = (this.setVersion || 0) + 1;
    this.worker.postMessage({ type: 'set', version: this.setVersion, positions: set.pos.slice(0, set.count * 3) });
    this.lastSortKey = '';
  }

  _onSorted(m) {
    const w = this.waiters.get(m.id); this.waiters.delete(m.id);
    if (m.version === this.setVersion && this.set && m.order.length === this.set.count) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
      gl.bufferData(gl.ARRAY_BUFFER, m.order, gl.DYNAMIC_DRAW);
      this.orderCount = m.order.length;
    }
    if (this.pending === m.id) this.pending = null;
    if (w) w();
  }

  // Ask for a fresh order for this view. Returns a promise that resolves when it is in place.
  sort(view, force = false) {
    const key = this.setVersion + ':' + Array.from(view).map(v => v.toFixed(3)).join(',');
    if (!force && (key === this.lastSortKey || this.pending !== null)) return null;
    this.lastSortKey = key;
    const id = ++this.sortId; this.pending = id;
    return new Promise(res => { this.waiters.set(id, res); this.worker.postMessage({ type: 'sort', id, version: this.setVersion, view }); });
  }

  matrices(cam, w, h) {
    const view = lookAt(cam.eye, cam.target, cam.roll);
    const proj = perspective(cam.fovY, w / h, cam.near, cam.far);
    const fy = h / (2 * Math.tan(cam.fovY / 2));
    return { view, proj, focal: [fy, fy] };
  }

  _target(w, h) {
    const gl = this.gl;
    if (!this.layer || this.layer.w !== w || this.layer.h !== h) {
      if (this.layer) { gl.deleteTexture(this.layer.tex); gl.deleteFramebuffer(this.layer.fbo); }
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.layer = { tex, fbo, w, h };
    }
    return this.layer;
  }

  _outTarget(w, h) {
    const gl = this.gl;
    if (!this.out || this.out.w !== w || this.out.h !== h) {
      if (this.out) { gl.deleteTexture(this.out.tex); gl.deleteFramebuffer(this.out.fbo); }
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.out = { tex, fbo, w, h };
    }
    return this.out;
  }

  // Draw one frame. P = look params, time in seconds, mats from matrices(). toOffscreen: render into an RGBA8 target.
  // mode: 0 opaque over the background colour, 1 transparent (straight alpha, for ProRes/PNG), 2 transparent preview
  draw(P, time, cam, w, h, toOffscreen = false, mode = 0) {
    const gl = this.gl, set = this.set;
    const m = this.matrices(cam, w, h);
    const L = this._target(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (set && this.orderCount === set.count) {
      const s = this.splat, u = s.u;
      gl.useProgram(s.p);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dataTex); gl.uniform1i(u.uData, 0);
      gl.uniformMatrix4fv(u.uView, false, m.view); gl.uniformMatrix4fv(u.uProj, false, m.proj);
      gl.uniform2f(u.uViewport, w, h); gl.uniform2f(u.uFocal, m.focal[0], m.focal[1]);
      gl.uniform1f(u.uTime, time); gl.uniform1f(u.uRadius, set.radius);
      gl.uniform3fv(u.uPivot, set.pivot); gl.uniform3fv(u.uSrcEye, set.srcEye); if (u.uInvf) gl.uniform1f(u.uInvf, set.invf || 0);
      const f1 = (name, v) => u[name] && gl.uniform1f(u[name], v);
      f1('uScale', P.scale); f1('uOpacity', P.opacity); f1('uJitter', P.jitter); f1('uFuzz', P.fuzz); f1('uFuzzLen', P.fuzzLen);
      f1('uDrip', P.drip); f1('uDripLen', P.dripLen); f1('uDripWidth', P.dripWidth);
      f1('uDripDir', P.dripDir === 'down' ? -1 : P.dripDir === 'up' ? 1 : 0); f1('uDripSpeed', P.dripSpeed); f1('uDripStart', P.dripStart || 0);
      if (u.uRowRange) gl.uniform2f(u.uRowRange, set.bbox ? set.bbox[1] : 0, set.bbox ? set.bbox[3] : 1024);
      f1('uFill', P.fill ?? 1); f1('uVeil', P.veil); f1('uVeilLen', P.veilLen); f1('uFloat', P.floaters); f1('uFloatSize', P.floaterSize);
      f1('uSmear', P.smear); f1('uSmearLen', P.smearLen); f1('uSmearAngle', P.smearAngle * DEG);
      const dur = Math.max(0.1, P.duration);
      const ramp = 1 - P.swirlRamp + P.swirlRamp * clamp(time / dur, 0, 1);
      f1('uSwirl', P.swirl * ramp); f1('uSwirlRadius', P.swirlRadius);
      if (u.uSwirlCenter) gl.uniform2f(u.uSwirlCenter, P.swirlX, P.swirlY);
      f1('uSphere', P.sphere); f1('uSphereRadius', P.sphereRadius); f1('uSphereSoft', P.sphereSoft); f1('uSphereSquash', P.sphereSquash);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.generateMipmap(gl.TEXTURE_2D);
    // post
    const target = toOffscreen ? this._outTarget(w, h) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    const q = this.post, u = q.u;
    gl.useProgram(q.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.uniform1i(u.uLayer, 0);
    gl.uniform2f(u.uRes, w, h); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uSeed, P.seed || 0);
    gl.uniform1i(u.uMode, mode);
    gl.uniform3fv(u.uBg, hexColor(P.bg)); gl.uniform3fv(u.uTint, hexColor(P.tint));
    const g1 = (name, v) => u[name] && gl.uniform1f(u[name], v);
    g1('uExposure', P.exposure); g1('uContrast', P.contrast); g1('uSat', P.saturation); g1('uBlacks', P.blacks); g1('uLift', P.lift);
    g1('uWarm', P.warmth); g1('uTintAmt', P.tintAmt); g1('uSoften', P.soften); g1('uGlow', P.glow); g1('uGrain', P.grain);
    g1('uVignette', P.vignette); g1('uBlocks', P.blocks); g1('uBlockSize', P.blockSize); g1('uBlockRate', P.blockRate);
    g1('uBlockShift', P.blockShift); g1('uStretch', P.stretch); g1('uStretchSize', P.stretchSize);
    gl.bindVertexArray(this.pvao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    return m;
  }

  readPixels(w, h, buf) {
    const gl = this.gl;
    const out = buf && buf.length === w * h * 4 ? buf : new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
