// Depth sort for the splat renderer: back-to-front order (farthest first) with a 16-bit counting sort.
// Messages in:  {type:'set', version, positions: Float32Array(xyz...)}
//               {type:'sort', id, version, view: Float32Array(16)}  (column-major view matrix)
// Messages out: {id, version, order: Uint32Array}
let pos = null, version = -1, zs = null, keys = null;
const counts = new Uint32Array(65536);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'set') {
    pos = m.positions;
    version = m.version;
    const n = pos.length / 3;
    if (!zs || zs.length < n) { zs = new Float32Array(n); keys = new Uint16Array(n); }
    return;
  }
  if (m.type !== 'sort' || !pos) return;
  const v = m.view, n = pos.length / 3;
  const a = v[2], b = v[6], c = v[10], d = v[14];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const z = a * pos[j] + b * pos[j + 1] + c * pos[j + 2] + d;
    zs[i] = z;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  const scale = hi > lo ? 65535 / (hi - lo) : 0;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const k = ((zs[i] - lo) * scale) | 0;
    keys[i] = k;
    counts[k]++;
  }
  // most negative view z (farthest) first
  let sum = 0;
  for (let k = 0; k < 65536; k++) { const c2 = counts[k]; counts[k] = sum; sum += c2; }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[counts[keys[i]]++] = i;
  self.postMessage({ id: m.id, version, order }, [order.buffer]);
};
