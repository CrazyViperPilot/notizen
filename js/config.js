// Shared constants. Page units: 0.1 mm.

export const PAGE = { p: { w: 2100, h: 2970 }, l: { w: 2970, h: 2100 } };
export const PAPERS = ['blank', 'lined', 'grid', 'dotted', 'vocab', 'lin1', 'lin2', 'lin3', 'lin4', 'math'];
export const PAPER_NAMES = {
  blank: 'Blanko', lined: 'Liniert', grid: 'Kariert', dotted: 'Gepunktet', vocab: 'Vokabeln',
  lin1: 'Lineatur 1', lin2: 'Lineatur 2', lin3: 'Lineatur 3', lin4: 'Lineatur 4', math: 'Rechenkästchen mit Rand',
};

export const PEN_COLORS = ['#1a1a1a', '#1f3a93', '#c0392b', '#1e8449', '#e67e22', '#7d3c98'];
export const PEN_COLOR_NAMES = ['Schwarz', 'Dunkelblau', 'Rot', 'Grün', 'Orange', 'Lila'];
/** A stroke color is an index into PEN_COLORS/HL_COLORS or a custom "#rrggbb". */
export const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
export const penColor = (c) => (isHexColor(c) ? c : PEN_COLORS[c] || PEN_COLORS[0]);
export const hlColor = (c) => (isHexColor(c) ? c : HL_COLORS[c] || HL_COLORS[0]);
export const DEFAULT_CUSTOM_COLOR = '#0a8f8f';
export const DEFAULT_CUSTOM_HL_COLOR = '#ffb000';

export const PEN_WIDTHS = [4, 7, 12];                 // base diameter in 0.1 mm
export const PEN_WIDTH_NAMES = ['Fein', 'Mittel', 'Dick'];
export const HL_COLORS = ['#ffe600', '#7dff6b', '#ff7ad9'];
export const HL_COLOR_NAMES = ['Gelb', 'Grün', 'Pink'];
export const HL_WIDTH = 50;
export const HL_ALPHA = 0.35;
/** Bleistift (Schraffur): Deckkraft eines Strichs; übereinander gemalt wird es dunkler. */
export const PENCIL_ALPHA = 0.45;

export const PAPER_STYLE = {
  lineColor: '#b8c7dd',
  dotColor: '#8f9db0',
  marginColor: '#e7a3a3',
  lined: 80,      // line spacing
  linedTop: 300,  // first line
  grid: 50,
  dotted: 50,
  margin: 250,    // left margin line on lined paper
  vocabTop: 300,  // vocab: first line (above it: room for a heading), then every `lined`
  vocabSplit: 0.47, // vocab: divider word | translation (share of page width)
  vocabCheck: 170,  // vocab: width of the tick column on the right
  bandColor: '#e6f4e1', // getönte Schreibband-Flächen (Lineatur 1 und 2)
};

// Schul-Lineaturen (Maße in 0,1 mm). Angelehnt an Schulhefte, an echte Hefte anpassbar.
// lin1–3: Schreibzeilen aus Ober-, Mittel-, Grund- und Unterlinie; band = Abstand zwischen zwei Linien,
// gap = Zwischenraum zur nächsten Zeile, tint = Mittelband getönt. lin4: Linien im Abstand `line`.
// top = erste Linie, mathMargin = Randlinien bei „Rechenkästchen mit Rand“ (links und rechts).
export const LINEATUR = {
  lin1: { band: 50, gap: 40, tint: true },
  lin2: { band: 40, gap: 35, tint: true },
  lin3: { band: 30, gap: 30, tint: false },
  lin4: { line: 90 },
  top: 250,
  mathMargin: 150,
};

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const PAGE_GAP = 16;     // CSS px between pages at zoom 1
export const PAGE_PAD = 16;     // CSS px around pages at zoom 1
export const ERASER_RADIUS = 12; // CSS px on screen
export const UNDO_LIMIT = 100;
export const SAVE_DELAY = 400;  // ms, debounce of the 'strokes' event per page
