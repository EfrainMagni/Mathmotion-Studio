import { glyphTransformOf, parseGlyphIds, type Clip, type GlyphTransformSpec, type Obj2D } from '../types';

/**
 * Glifos de una fórmula MathJax (estilo submobjects de MathTex en Manim).
 * Funciones puras y sin estado: las comparten el runtime, el inspector y el exportador.
 */

const GLYPH_LEAF = new Set(['path', 'rect', 'line', 'circle', 'ellipse', 'polygon', 'polyline', 'text']);
const SKIP = new Set([
  'defs', 'clippath', 'mask', 'pattern', 'symbol', 'marker', 'lineargradient', 'radialgradient', 'filter', 'style',
]);

/** Convierte letras/dígitos matemáticos de Unicode (𝑥, 𝟐…) a su carácter ASCII base. */
export function plainChar(hex: string | null): string {
  if (!hex) return '';
  const code = parseInt(hex, 16);
  if (!Number.isFinite(code)) return '';
  if (code >= 0x1d400 && code <= 0x1d6a3) {
    const i = (code - 0x1d400) % 52;
    return String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26);
  }
  if (code >= 0x1d7ce && code <= 0x1d7ff) return String.fromCharCode(48 + ((code - 0x1d7ce) % 10));
  if (code === 0x210e) return 'h';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Carácter visible de un glifo; las reglas (barra de fracción, raíz) se representan con «—». */
export function glyphChar(el: Element): string {
  const own = el.getAttribute('data-c');
  if (own) return plainChar(own);
  const inner = el.querySelector('[data-c]');
  if (inner) return plainChar(inner.getAttribute('data-c'));
  return el.localName.toLowerCase() === 'rect' ? '—' : '';
}

/** Clave de emparejamiento: el carácter y, si no lo hay, la forma SVG del glifo (trazo o referencia). */
export function glyphKey(el: Element): string {
  const char = glyphChar(el);
  if (char) return char;
  const shape = el.hasAttribute('d') ? el : el.querySelector('[d]');
  const d = shape?.getAttribute('d');
  if (d) return `~${d.replace(/\s+/g, '')}`;
  const use = el.localName.toLowerCase() === 'use' ? el : el.querySelector('use');
  const href = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
  return href ? `#${href}` : '';
}

/**
 * Hojas visuales de la fórmula en orden de documento: elementos con `data-c`
 * o primitivas de dibujo sin ancestro `data-c`. El índice en la lista es el índice del glifo.
 */
export function findGlyphElements(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.localName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (el.hasAttribute('data-c') || GLYPH_LEAF.has(tag)) out.push(el);
      else walk(el);
    }
  };
  walk(root);
  return out;
}

/** «0-2,5» → [0,1,2,5]. Ignora lo que no sea válido. */
export function parseGlyphList(text: string, limit = 5000): number[] {
  const set = new Set<number>();
  for (const part of text.split(/[,\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && set.size < limit; i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

/** Tramos contiguos [inicio, fin] (fin inclusive) de una lista de índices. */
export function glyphRuns(indices: number[]): [number, number][] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs;
}

export const formatGlyphList = (indices: number[]) =>
  glyphRuns(indices).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');

/** Glifos a los que apunta un clip: término vivo, lista guardada o `null` (toda la ecuación). */
export function clipGlyphs(object: Obj2D, params: Record<string, number | string | boolean>): number[] | null {
  const termId = typeof params.term === 'string' ? params.term : '';
  const term = termId ? object.terms?.find((entry) => entry.id === termId) : undefined;
  if (term) return [...term.glyphs].sort((a, b) => a - b);
  if (typeof params.glyphs === 'string' && params.glyphs.trim()) {
    const list = parseGlyphList(params.glyphs);
    return list.length ? list : null;
  }
  return null;
}

/** Transformación dirigida glifo → glifo ya resuelta a índices (`src[i]` viaja a `dst[i]`). */
export interface DirectedGlyphClip {
  clip: Clip;
  spec: GlyphTransformSpec;
  src: number[];
  dst: number[];
}

/** Clips `transform` con `targetGlyphIds`, ordenados por inicio. */
export function directedGlyphClips(clips: Clip[]): DirectedGlyphClip[] {
  const out: DirectedGlyphClip[] = [];
  for (const clip of clips) {
    const spec = glyphTransformOf(clip);
    if (!spec) continue;
    const src = parseGlyphIds(spec.sourceObjectId, spec.sourceGlyphIds.join(','));
    const dst = parseGlyphIds(spec.targetObjectId, spec.targetGlyphIds.join(','));
    if (src.length && src.length === dst.length) out.push({ clip, spec, src, dst });
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

/** Glifos que reciben algún clip dirigido, por objeto destino. */
export function directedTargets(list: DirectedGlyphClip[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const d of list) {
    const set = map.get(d.spec.targetObjectId) ?? new Set<number>();
    for (const j of d.dst) set.add(j);
    map.set(d.spec.targetObjectId, set);
  }
  return map;
}

const CONNECTOR_CHARS = new Set('·⋅∙∗*×+-−=<>≤≥≠≈≡()[]{}|,;:'.split(''));
export const isConnectorChar = (char: string) => CONNECTOR_CHARS.has(char);

/**
 * Conectores de una ecuación destino que brotan con un clip dirigido (`revealConnectors`): glifo → clip.
 * Un conector es un glifo operador/paréntesis sin glifo dirigido; lo revela el primer clip marcado que
 * termina cuando sus vecinos dirigidos más próximos (izquierdo y derecho) ya llegaron o aterrizan en él.
 */
export function connectorPlan(
  list: DirectedGlyphClip[], objectId: string, chars: string[], targeted: Set<number>,
): Map<number, DirectedGlyphClip> {
  const plan = new Map<number, DirectedGlyphClip>();
  const mine = list.filter((d) => d.spec.targetObjectId === objectId);
  const flagged = mine.filter((d) => d.spec.revealConnectors)
    .sort((a, b) => a.clip.start + a.clip.duration - (b.clip.start + b.clip.duration));
  if (!flagged.length) return plan;
  const arrive = new Map<number, number>();
  for (const d of mine) for (const j of d.dst) arrive.set(j, Math.min(arrive.get(j) ?? Infinity, d.clip.start + d.clip.duration));
  chars.forEach((char, j) => {
    if (targeted.has(j) || !isConnectorChar(char)) return;
    let left = j - 1;
    while (left >= 0 && !targeted.has(left)) left--;
    let right = j + 1;
    while (right < chars.length && !targeted.has(right)) right++;
    const times = [left, right].filter((i) => i >= 0 && i < chars.length).map((i) => arrive.get(i) ?? 0);
    if (!times.length) return;
    const ready = Math.max(...times);
    const via = flagged.find((d) => d.clip.start + d.clip.duration >= ready - 1e-9);
    if (via) plan.set(j, via);
  });
  return plan;
}

/**
 * Alcance de un clip de entrada (Write/FadeIn) sobre una fórmula: la selección guardada o, si la fórmula
 * recibe glifos dirigidos, solo los glifos que no llegan desde otro objeto. `null` = toda la ecuación.
 */
export function entranceScope(
  object: Obj2D, params: Record<string, number | string | boolean>, targeted: Set<number> | undefined, count: number,
): number[] | null {
  const explicit = clipGlyphs(object, params);
  if (explicit) return explicit.filter((i) => i < count);
  if (!targeted?.size) return null;
  return Array.from({ length: count }, (_, i) => i).filter((i) => !targeted.has(i));
}

/**
 * Empareja glifos iguales entre dos ecuaciones (TransformMatchingTex): primero la mayor
 * subsecuencia común (conserva el orden) y después los repetidos que sigan sin pareja.
 */
export function matchGlyphs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const same = (i: number, j: number) => a[i] !== '' && a[i] === b[j];
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = same(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (same(i, j) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      usedA.add(i);
      usedB.add(j);
      i++;
      j++;
    } else if (dp[i + 1][j] > dp[i][j + 1]) i++;
    else j++;
  }
  for (let i = 0; i < n; i++) {
    if (usedA.has(i)) continue;
    const j = b.findIndex((char, index) => !usedB.has(index) && same(i, index) && char === a[i]);
    if (j < 0) continue;
    pairs.push([i, j]);
    usedA.add(i);
    usedB.add(j);
  }
  return pairs.sort((x, y) => x[0] - y[0]);
}

export type RGB = [number, number, number];

export function parseColor(css: string | undefined | null): RGB | null {
  if (!css) return null;
  const hex = css.trim().match(/^#([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export const toHexColor = (rgb: RGB) =>
  '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Mezcla lineal de dos colores CSS; si alguno no se entiende devuelve `b` a partir de t ≥ 0.5. */
export function mixColor(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return t >= 0.5 ? b : a;
  return toHexColor([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * t) as RGB);
}
