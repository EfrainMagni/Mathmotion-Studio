import { DEFAULT_ARC, fontStack, isPathTool, type FillGradient, type PathNode, type GradientStop, type LegacyLineTip, type LineTip, type VectorGeometry, type VectorTool, type Vertex } from '../types';

export const VECTOR_LABEL: Record<VectorTool, string> = {
  rectangle: 'Rectángulo', ellipse: 'Círculo / Elipse', line: 'Línea / Vector',
  arrow: 'Flecha vectorial', text: 'Texto libre', polygon: 'Polígono',
  pen: 'Pluma Bézier / Ángulos', curve: 'Curva suavizada', arc: 'Arco circular / Flecha curva',
};

/** Líneas, flechas y trazados abiertos: su pintura principal es el trazo (degradado en el trazo, puntas de flecha). */
export function isLinearVector(vector: VectorGeometry | undefined): boolean {
  if (!vector) return false;
  return vector.tool === 'line' || vector.tool === 'arrow' || vector.tool === 'arc' || (isPathTool(vector.tool) && !vector.closed);
}

export const VECTOR_FILL = '#38bdf8';
export const VECTOR_STROKE = '#38bdf8';
export const VECTOR_STROKE_WIDTH = 4;

export const GRADIENT_PRESETS: { id: string; label: string; colors: [string, string] }[] = [
  { id: 'manim', label: 'Manim Azul-Menta', colors: ['#58C4DD', '#83C167'] },
  { id: 'solar', label: 'Solar / Dorado', colors: ['#F7971E', '#FFD200'] },
  { id: 'neon', label: 'Neón Cian-Violeta', colors: ['#00F5D4', '#7B2CBF'] },
  { id: 'carmesi', label: 'Carmesí-Ámbar', colors: ['#FF4D6D', '#FF9E00'] },
];

let stopSerial = 0;
export const newStopId = () => `s${Date.now().toString(36)}${(stopSerial++).toString(36)}`;

export function makeGradient(mode: 'linear' | 'radial', colors: string[], angle = 0): FillGradient {
  const last = Math.max(1, colors.length - 1);
  return { mode, angle, stops: colors.map((color, i): GradientStop => ({ id: newStopId(), offset: Math.round((100 * i) / last), color })) };
}

/** Id único (por nodo) del degradado dentro del documento SVG compuesto. */
export const gradientId = (nodeId: string) => `mmg-${nodeId.replace(/[^\w-]/g, '-')}`;

const attr = (value: string) => value.replace(/[^\w#(),.%\s/+-]/g, '');

/** CSS `linear-gradient()` equivalente, para la barra de vista previa del inspector (0° = izquierda → derecha). */
export function gradientCss(g: FillGradient) {
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset).map((s) => `${attr(s.color)} ${s.offset}%`).join(', ');
  return g.mode === 'radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(${g.angle + 90}deg, ${stops})`;
}

/**
 * `<linearGradient>` / `<radialGradient>` con id `id`. Por defecto usa `objectBoundingBox`; con `box` (líneas y flechas,
 * cuya caja puede tener alto 0) usa coordenadas de usuario.
 */
export function gradientMarkup(id: string, g: FillGradient, box?: { x: number; y: number; w: number; h: number }) {
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset)
    .map((s) => `<stop offset="${Math.min(100, Math.max(0, s.offset))}%" stop-color="${attr(s.color)}"/>`).join('');
  const b = box ? { x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h) } : { x: 0, y: 0, w: 1, h: 1 };
  const units = box ? 'userSpaceOnUse' : 'objectBoundingBox';
  if (g.mode === 'radial') {
    const r = box ? Math.hypot(b.w, b.h) / 2 : 0.5;
    return `<radialGradient id="${id}" gradientUnits="${units}" cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" r="${r}">${stops}</radialGradient>`;
  }
  const t = (g.angle * Math.PI) / 180;
  const dx = Math.cos(t) / 2;
  const dy = Math.sin(t) / 2;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return `<linearGradient id="${id}" gradientUnits="${units}" x1="${cx - dx * b.w}" y1="${cy - dy * b.h}" x2="${cx + dx * b.w}" y2="${cy + dy * b.h}">${stops}</linearGradient>`;
}

export function regularPolygon(center: Vertex, radius: number, sides: number, angle = -Math.PI / 2) {
  const diameter = radius * 2;
  const vertices = Array.from({ length: sides }, (_, index) => {
    const theta = angle + 2 * Math.PI * index / sides;
    return { x: radius + radius * Math.cos(theta), y: radius + radius * Math.sin(theta) };
  });
  const vector: VectorGeometry = { tool: 'polygon', vertices };
  return { x: center.x - radius, y: center.y - radius, bw: diameter, bh: diameter, vector };
}

function xml(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const LINE_TIPS: Record<LineTip, string> = {
  none: 'Ninguna',
  stealth: 'Flecha afilada',
  right: 'Triángulo recto',
};

/** Mapea puntas antiguas (triangle/open/circle) a uno de los dos diseños vigentes. */
export function normalizeTip(tip: LineTip | LegacyLineTip | undefined): LineTip {
  if (tip === 'none' || tip === undefined) return 'none';
  return tip === 'right' || tip === 'triangle' ? 'right' : 'stealth';
}

export function lineTips(vector: VectorGeometry) {
  const legacy = vector.tool === 'arrow' ? vector.tip ?? 'triangle' : 'none';
  return {
    start: normalizeTip(vector.startTip ?? (legacy === 'both' ? 'triangle' : 'none')),
    // El arco lleva por defecto un triángulo recto sólido de base plana al final.
    end: normalizeTip(vector.endTip ?? (vector.tool === 'arc' ? 'right' : legacy === 'both' ? 'triangle' : legacy)),
    scale: vector.tipScale ?? 1,
  };
}

const STEALTH_NOTCH = 0.72;

/** Longitud y semiancho de la punta, proporcionales al grosor real del trazo. */
function tipSize(tip: LineTip, sw: number, scale: number) {
  const length = (tip === 'stealth' ? Math.max(14, sw * 4.2) : Math.max(13, sw * 3.8)) * scale;
  return { length, half: length * (tip === 'stealth' ? 0.42 : 0.45) };
}

/** Distancia que el cuerpo de la línea retrocede desde el vértice (muesca o base de la punta). */
function tipInset(tip: LineTip, sw: number, scale: number) {
  if (tip === 'none') return 0;
  const { length } = tipSize(tip, sw, scale);
  return tip === 'stealth' ? length * STEALTH_NOTCH : length;
}

/** Vértices del polígono de una punta en `(x, y)` apuntando hacia `theta`. */
export function tipPoints(tip: LineTip, x: number, y: number, theta: number, sw: number, scale: number) {
  const { length, half } = tipSize(tip, sw, scale);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const at = (back: number, side: number) => `${(x - ux * back - uy * side).toFixed(3)},${(y - uy * back + ux * side).toFixed(3)}`;
  const pts = tip === 'stealth'
    ? [at(0, 0), at(length, -half), at(length * STEALTH_NOTCH, 0), at(length, half)]
    : [at(0, 0), at(length, -half), at(length, half)];
  return pts.join(' ');
}

/** Geometría de las puntas y del recorte del cuerpo para una línea con grosor `sw`. */
export function tipLayout(start: Vertex, end: Vertex, tips: ReturnType<typeof lineTips>, sw: number) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);
  const startInset = Math.min(tipInset(tips.start, sw, tips.scale), length);
  const endInset = tipInset(tips.end, sw, tips.scale);
  const to = Math.max(startInset, length - endInset);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const half = 1e4;
  const at = (t: number, k: number) => `${(start.x + ux * t - uy * k).toFixed(3)},${(start.y + uy * t + ux * k).toFixed(3)}`;
  return {
    start: tips.start === 'none' ? null : tipPoints(tips.start, start.x, start.y, theta + Math.PI, sw, tips.scale),
    end: tips.end === 'none' ? null : tipPoints(tips.end, end.x, end.y, theta, sw, tips.scale),
    clip: !length || (!startInset && !endInset) ? null : [at(startInset, -half), at(to, -half), at(to, half), at(startInset, half)].join(' '),
  };
}

// ------------------------------------------------------------------ trazados Bézier (pluma y curva suavizada)

export type Cubic = [Vertex, Vertex, Vertex, Vertex];
const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
const same = (a: Vertex, b: Vertex) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const lerp = (a: Vertex, b: Vertex, t: number): Vertex => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Segmentos cúbicos del trazado (el último une fin e inicio si está cerrado). */
export function pathSegments(nodes: PathNode[], closed: boolean): Cubic[] {
  const count = closed ? nodes.length : nodes.length - 1;
  const segments: Cubic[] = [];
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    segments.push([{ x: a.x, y: a.y }, a.out ?? { x: a.x, y: a.y }, b.in ?? { x: b.x, y: b.y }, { x: b.x, y: b.y }]);
  }
  return segments;
}

function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}

const cubicAt = (c: Cubic, t: number) => splitCubic(c, t)[0][3];

/**
 * Recorta el segmento justo en la base de la punta: el plano perpendicular a la dirección de la punta (`theta`)
 * situado a `inset` px por detrás del extremo. Así el cuerpo termina en la base plana del triángulo (o en la
 * muesca de la flecha afilada) aunque la curva se doble, sin asomar por los lados ni torcerse.
 */
function trimToBase(c: Cubic, inset: number, fromEnd: boolean, theta: number): Cubic {
  if (inset <= 0) return c;
  const anchor = fromEnd ? c[3] : c[0];
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  // Distancia, medida a lo largo de la punta, desde el extremo hacia atrás hasta el punto de la curva.
  const behind = (s: number) => {
    const p = cubicAt(c, fromEnd ? 1 - s : s);
    return (anchor.x - p.x) * ux + (anchor.y - p.y) * uy;
  };
  if (behind(1) <= inset) return fromEnd ? [c[0], c[0], c[0], c[0]] : [c[3], c[3], c[3], c[3]];
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (behind(mid) < inset) lo = mid; else hi = mid;
  }
  const s = (lo + hi) / 2;
  return fromEnd ? splitCubic(c, 1 - s)[0] : splitCubic(c, s)[1];
}

/**
 * Dirección exacta de la punta: derivada de la cúbica en el extremo, B'(1) = 3·(P3 − P2) al final y −B'(0) =
 * −3·(P1 − P0) al inicio (apunta hacia fuera). Si ese manejador es nulo se usa el siguiente punto de control distinto.
 */
function endDirection(c: Cubic, end: boolean): number {
  const [p0, p1, p2, p3] = c;
  const tip = end ? p3 : p0;
  const from = (end ? [p2, p1, p0] : [p1, p2, p3]).find((p) => Math.hypot(tip.x - p.x, tip.y - p.y) > 1e-6) ?? tip;
  const dx = 3 * (tip.x - from.x);
  const dy = 3 * (tip.y - from.y);
  return Math.atan2(dy, dx);
}

function segmentsToD(segments: Cubic[], closed: boolean): string {
  if (!segments.length) return '';
  const [s0] = segments[0];
  let d = `M${fmt(s0.x)} ${fmt(s0.y)}`;
  for (const [p0, p1, p2, p3] of segments) {
    const straight = same(p0, p1) && same(p2, p3);
    d += straight ? ` L${fmt(p3.x)} ${fmt(p3.y)}` : ` C${fmt(p1.x)} ${fmt(p1.y)} ${fmt(p2.x)} ${fmt(p2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`;
  }
  return closed ? `${d} Z` : d;
}

/**
 * Segmentos cúbicos (ya recortados en las puntas) y polígonos de las puntas de un trazado para un grosor `sw`.
 * Lo comparten el SVG del editor (`pathLayout`) y la exportación a Manim (puntos de control de un `VMobject`).
 */
export function pathBody(vector: VectorGeometry, sw: number): { segments: Cubic[]; closed: boolean; start: string | null; end: string | null } {
  const nodes = vector.nodes ?? [];
  const closed = !!vector.closed && nodes.length > 2;
  const segments = pathSegments(nodes, closed);
  if (!segments.length || closed) return { segments, closed, start: null, end: null };
  const tips = lineTips(vector);
  const first = segments[0];
  const last = segments[segments.length - 1];
  const startTheta = endDirection(first, false);
  const endTheta = endDirection(last, true);
  const start = tips.start === 'none' ? null : tipPoints(tips.start, first[0].x, first[0].y, startTheta, sw, tips.scale);
  const end = tips.end === 'none' ? null : tipPoints(tips.end, last[3].x, last[3].y, endTheta, sw, tips.scale);
  const body = segments.slice();
  body[body.length - 1] = trimToBase(body[body.length - 1], tipInset(tips.end, sw, tips.scale), true, endTheta);
  body[0] = trimToBase(body[0], tipInset(tips.start, sw, tips.scale), false, startTheta);
  return { segments: body, closed, start, end };
}

/**
 * Datos `d` del trazado y polígonos de sus puntas para un grosor `sw`. En los trazados abiertos con punta, el
 * cuerpo se recorta en la muesca/base de la punta (igual que `tipLayout` en las líneas).
 */
export function pathLayout(vector: VectorGeometry, sw: number) {
  const { segments, closed, start, end } = pathBody(vector, sw);
  if (!segments.length) return { d: '', start: null as string | null, end: null as string | null };
  return { d: segmentsToD(segments, closed), start, end };
}

/** Manejadores simétricos de un nodo suave a partir de sus vecinos (tangente tipo Catmull-Rom). */
function smoothHandles(prev: Vertex | null, node: Vertex, next: Vertex | null): { in: Vertex; out: Vertex } {
  // Interior: (siguiente − anterior)/6 (Catmull-Rom). Extremo abierto: 1/3 hacia su único vecino.
  const a = prev ?? node;
  const b = next ?? node;
  const k = prev && next ? 1 / 6 : 1 / 3;
  const tx = (b.x - a.x) * k;
  const ty = (b.y - a.y) * k;
  return { in: { x: node.x - tx, y: node.y - ty }, out: { x: node.x + tx, y: node.y + ty } };
}

/** Alterna un nodo entre ángulo (`corner`, sin manejadores) y curva suave (`smooth`, manejadores simétricos). */
export function toggleNodeType(nodes: PathNode[], index: number, closed: boolean): PathNode[] {
  const node = nodes[index];
  if (!node) return nodes;
  if (node.type === 'smooth') return nodes.map((n, i) => (i === index ? { x: n.x, y: n.y, type: 'corner' } : n));
  const n = nodes.length;
  const prev = index > 0 ? nodes[index - 1] : closed && n > 2 ? nodes[n - 1] : null;
  const next = index < n - 1 ? nodes[index + 1] : closed && n > 2 ? nodes[0] : null;
  return nodes.map((p, i) => (i === index ? { x: p.x, y: p.y, type: 'smooth', ...smoothHandles(prev, p, next) } : p));
}

/** Simplificación Ramer-Douglas-Peucker de una polilínea. */
export function simplifyPoints(points: Vertex[], epsilon: number): Vertex[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a], pb = points[b];
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    let max = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const d = len < 1e-9 ? Math.hypot(p.x - pa.x, p.y - pa.y)
        : Math.abs((pb.x - pa.x) * (pa.y - p.y) - (pa.x - p.x) * (pb.y - pa.y)) / len;
      if (d > max) { max = d; at = i; }
    }
    if (max > epsilon && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Convierte una polilínea (ya simplificada) en un trazado de nodos suaves. */
export function smoothPath(points: Vertex[], closed: boolean): PathNode[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : closed ? points[n - 1] : null;
    const next = i < n - 1 ? points[i + 1] : closed ? points[0] : null;
    return { x: p.x, y: p.y, type: 'smooth', ...smoothHandles(prev, p, next) };
  });
}

/** Desplaza todos los puntos (nodos y manejadores) de un trazado. */
export function translateNodes(nodes: PathNode[], dx: number, dy: number): PathNode[] {
  const t = (v: Vertex | undefined) => v && { x: v.x + dx, y: v.y + dy };
  return nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy, in: t(node.in), out: t(node.out) }));
}

/** Caja de nodos y manejadores (los manejadores contienen siempre la curva cúbica). */
export function nodesBounds(nodes: PathNode[]) {
  const all = nodes.flatMap((node) => [node, node.in, node.out].filter((v): v is Vertex => !!v));
  const xs = all.map((v) => v.x);
  const ys = all.map((v) => v.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ------------------------------------------------------------------ arco circular / flecha curva

/**
 * Punto del arco. Ángulos en grados en coordenadas de pantalla (+X derecha, +Y abajo): 0° = derecha, 90° = abajo,
 * 135° = abajo a la izquierda. El barrido negativo gira en sentido horario en pantalla (el ángulo de pantalla crece).
 */
export function arcPoint(cx: number, cy: number, r: number, degrees: number): Vertex {
  const t = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
}

/** Ángulo de pantalla del punto final: `startAngle − sweep` (−270 → 270° horario: 135° → 405° ≡ 45°). */
export const arcEndAngle = (startAngle: number, sweep: number) => startAngle - sweep;

/** Centro y radio del círculo inscrito en una caja `w×h`. */
export const arcCircle = (w: number, h: number) => ({ cx: w / 2, cy: h / 2, r: Math.max(0.5, Math.min(w, h) / 2) });

/**
 * Nodos Bézier de un arco circular exacto: tramos de ≤ 90° con manejadores `k = 4/3·tan(Δ/4)` (error < 0.03 %).
 * Así el arco reutiliza el recorte de puntas, la tangente real en los extremos y el dibujo progresivo de los trazados.
 */
export function arcNodes(vector: VectorGeometry, w: number, h: number): PathNode[] {
  const { startAngle, sweep } = vector.arc ?? DEFAULT_ARC;
  const { cx, cy, r } = arcCircle(w, h);
  const total = Math.max(-360, Math.min(360, sweep)) || 0.001;
  const steps = Math.max(1, Math.ceil(Math.abs(total) / 90 - 1e-9));
  const delta = total / steps;
  const k = (4 / 3) * Math.tan((Math.abs(delta) * Math.PI) / 720) * r;
  // El ángulo de pantalla avanza en −delta por tramo: con barrido negativo crece (giro horario en pantalla).
  const dir = -Math.sign(delta);
  const tangent = (deg: number) => {
    // Dirección de avance: d/dφ (cos φ, sin φ) = (−sin φ, cos φ), con el signo del avance angular.
    const t = (deg * Math.PI) / 180;
    return { x: -Math.sin(t) * dir, y: Math.cos(t) * dir };
  };
  return Array.from({ length: steps + 1 }, (_, i) => {
    const deg = startAngle - delta * i;
    const p = arcPoint(cx, cy, r, deg);
    const u = tangent(deg);
    return {
      x: p.x, y: p.y, type: 'smooth',
      in: i > 0 ? { x: p.x - u.x * k, y: p.y - u.y * k } : undefined,
      out: i < steps ? { x: p.x + u.x * k, y: p.y + u.y * k } : undefined,
    };
  });
}

/** Trazado del arco como geometría de nodos (abierto) para `pathLayout`. */
export const arcAsPath = (vector: VectorGeometry, w: number, h: number): VectorGeometry =>
  ({ ...vector, nodes: arcNodes(vector, w, h), closed: false });

/** Contorno por defecto de rectángulos, elipses y polígonos (desactivado hasta que el inspector le dé color). */
export const CLOSED_STROKE_WIDTH_MIN = 0.5;
export const CLOSED_STROKE_WIDTH_MAX = 30;
function closedStroke() {
  return `stroke="none" stroke-width="${VECTOR_STROKE_WIDTH}" stroke-linejoin="miter" stroke-miterlimit="10"`;
}

export function vectorSvg(vector: VectorGeometry, width: number, height: number) {
  const { tool, reverseX, reverseY, text, textStyle } = vector;
  const [start, end] = vector.endpoints ?? [
    { x: width <= 1 ? 0.5 : reverseX ? width : 0, y: height <= 1 ? 0.5 : reverseY ? height : 0 },
    { x: width <= 1 ? 0.5 : reverseX ? 0 : width, y: height <= 1 ? 0.5 : reverseY ? 0 : height },
  ];
  const fill = `fill="${VECTOR_FILL}"`;
  // Figuras cerradas: relleno y contorno son pinturas independientes. El contorno nace desactivado
  // (`stroke="none"`) pero con grosor y unión definidos, para que al activarlo en el inspector sea nítido.
  const shape = `${fill} ${closedStroke()}`;
  const stroke = `stroke="${VECTOR_STROKE}" stroke-width="${VECTOR_STROKE_WIDTH}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"`;
  const tips = lineTips(vector);
  const linear = tool === 'line' || tool === 'arrow';
  const layout = linear ? tipLayout(start, end, tips, VECTOR_STROKE_WIDTH) : null;
  const heads = layout?.clip ? `<defs><clipPath id="tip-clip" clipPathUnits="userSpaceOnUse"><polygon points="${layout.clip}"/></clipPath></defs>` : '';
  const line = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" ${stroke}${layout?.clip ? ' clip-path="url(#tip-clip)"' : ''}/>`
    + (['start', 'end'] as const).map((k) => layout?.[k] ? `<polygon data-mm-tip="${k}" points="${layout[k]}" fill="${VECTOR_STROKE}" stroke="none"/>` : '').join('');
  const path = isPathTool(tool) ? pathLayout(vector, VECTOR_STROKE_WIDTH)
    : tool === 'arc' ? pathLayout(arcAsPath(vector, width, height), VECTOR_STROKE_WIDTH) : null;
  const pathMarkup = !path ? '' : vector.closed && tool !== 'arc'
    ? `<path d="${path.d}" ${shape}/>`
    : `<path d="${path.d}" fill="none" ${stroke}/>`
      + (['start', 'end'] as const).map((k) => path[k] ? `<polygon data-mm-tip="${k}" points="${path[k]}" fill="${VECTOR_STROKE}" stroke="none"/>` : '').join('');
  const markup = {
    pen: pathMarkup,
    curve: pathMarkup,
    arc: pathMarkup,
    polygon: `<polygon points="${vector.vertices?.map(({ x, y }) => `${x},${y}`).join(' ') ?? ''}" ${shape}/>`,
    rectangle: `<rect width="${width}" height="${height}" ${shape}/>`,
    ellipse: `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${shape}/>`,
    line,
    arrow: line,
    text: textStyle
      ? `<text x="${textStyle.align === 'center' ? width / 2 : textStyle.align === 'right' ? width : 0}" y="${height * 0.8}" font-family="${fontStack(textStyle.fontFamily).replaceAll('"', '')}" font-size="${height}" font-weight="${textStyle.fontWeight}" font-style="${textStyle.italic ? 'italic' : 'normal'}" text-anchor="${textStyle.align === 'center' ? 'middle' : textStyle.align === 'right' ? 'end' : 'start'}" letter-spacing="${textStyle.letterSpacing}" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`
      : `<text x="0" y="${height * 0.8}" font-family="sans-serif" font-size="${height}" textLength="${width}" lengthAdjust="spacingAndGlyphs" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${Math.max(1, width)} ${Math.max(1, height)}" overflow="visible">${heads}${markup[tool]}</svg>`;
}
