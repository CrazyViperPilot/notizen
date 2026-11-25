// Erzeugt Beispiel-PDFs im PDF/A-2b-Modus für die Prüfung mit veraPDF (CI-Job „pdfa“ in .github/workflows/test.yml).
// Aufruf: node test/pdfa/samples.mjs <Ausgabeordner>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPdf } from '../../js/export/pdf.js';
import { encodeStrokes } from '../../js/ink/codec.js';

const out = process.argv[2] || 'pdfa-out';
mkdirSync(out, { recursive: true });

const st = (id, type, color, width, pts) => ({ id, type, color, width, pts: Int32Array.from(pts) });
const ink = encodeStrokes([
  st('pen00001', 'p', 1, 1, [200, 400, 150, 600, 500, 200, 900, 450, 255]),
  st('hl000001', 'h', 0, 0, [200, 700, 128, 1200, 700, 128]),
  st('bl000001', 'b', '#7d3c98', 2, [300, 900, 60, 800, 1000, 120]),
]);
const gray = (w, h) => { const g = new Uint8Array(w * h).fill(255); for (let i = 0; i < g.length; i += 7) g[i] = 30; return { w, h, gray: g }; };
const cover = {
  size: 'a4', orient: 'p',
  boxes: [{ x: 0, y: 0, w: 80, h: 2970, color: '#2f5fd0' }],
  lines: [{ x1: 300, y1: 900, x2: 1800, y2: 900, width: 5, color: '#555555' }],
  texts: [{ x: 300, y: 500, w: 1500, h: 200, img: gray(150, 20) }],
};
const numberImage = () => ({ w: 60, h: 32, img: gray(18, 10) });
const date = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));

const samples = {
  'einfach.pdf': [{ paper: 'lined', orient: 'p', strokes: ink }],
  'formate.pdf': [
    { paper: 'grid', orient: 'p', size: 'a5', strokes: ink, label: 'A5' },
    { paper: 'mm', orient: 'l', size: 'a3', strokes: ink, label: 'A3 quer' },
    { paper: 'music', orient: 'p', strokes: ink },
    { paper: 'iso', orient: 'p', strokes: ink, over: ink },
  ],
};
for (const [name, pages] of Object.entries(samples)) {
  const bytes = buildPdf(pages, { title: 'Prüfung Ä & <Test>', pdfa: true, cover: name === 'formate.pdf' ? cover : null, numberImage, date });
  writeFileSync(join(out, name), bytes);
}
console.log('geschrieben:', Object.keys(samples).join(', '));
