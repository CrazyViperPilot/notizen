// Stroke (de)serialization. Wire/storage format (docs/ARCHITEKTUR.md 3.3):
//   [{"i":"k3x9a1b2","t":"p","c":0,"w":1,"p":[x0,y0,p0, dx1,dy1,dp1, …]}]   c = Farbindex oder "#rrggbb"
// In memory: {id, type: 'p'|'h', color, width, pts: Int32Array (x,y,p absolute)}.

import { isHexColor } from '../config.js';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function strokeId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const v of b) s += ID_CHARS[v % ID_CHARS.length];
  return s;
}

export function encodeStroke(s) {
  const pts = s.pts;
  const d = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) d[i] = i < 3 ? pts[i] : pts[i] - pts[i - 3];
  return { i: s.id, t: s.type, c: s.color, w: s.type === 'h' ? 0 : s.width, p: d };
}

export function encodeStrokes(strokes) {
  return JSON.stringify(strokes.map(encodeStroke));
}

/** Tolerant: skips malformed entries instead of throwing. */
export function decodeStrokes(str) {
  let arr;
  try {
    arr = typeof str === 'string' && str !== '' ? JSON.parse(str) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const o of arr) {
    if (!o || !Array.isArray(o.p) || o.p.length < 3 || o.p.length % 3 !== 0) continue;
    const type = o.t === 'h' ? 'h' : 'p';
    const pts = new Int32Array(o.p.length);
    let ok = true;
    for (let i = 0; i < o.p.length; i++) {
      const v = o.p[i];
      if (!Number.isFinite(v)) { ok = false; break; }
      pts[i] = i < 3 ? v : pts[i - 3] + v;
    }
    if (!ok) continue;
    out.push({
      id: typeof o.i === 'string' && o.i ? o.i : strokeId(),
      type,
      color: isHexColor(o.c) ? o.c.toLowerCase() : Number.isInteger(o.c) && o.c >= 0 ? o.c : 0,
      width: type === 'h' ? 0 : (Number.isInteger(o.w) && o.w >= 0 && o.w <= 2 ? o.w : 1),
      pts,
    });
  }
  return out;
}
