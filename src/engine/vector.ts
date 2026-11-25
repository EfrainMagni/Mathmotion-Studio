import { fontStack, type FillGradient, type GradientStop, type LegacyLineTip, type LineTip, type VectorGeometry, type VectorTool, type Vertex } from '../types';

export const VECTOR_LABEL: Record<VectorTool, string> = {
  rectangle: 'Rectángulo', ellipse: 'Círculo / Elipse', line: 'Línea / Vector',
  arrow: 'Flecha vectorial', text: 'Texto libre', polygon: 'Polígono',
};

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

/** Longitud y semiancho de la punta, en múltiplos del grosor de trazo. */
const TIP_LENGTH = 5;
const TIP_HALF_WIDTH = 2;
/** Fracción de la longitud donde queda la muesca trasera de la flecha afilada. */
const STEALTH_NOTCH = 0.72;

/** Mapea puntas antiguas (triangle/open/circle) a uno de los dos diseños vigentes. */
export function normalizeTip(tip: LineTip | LegacyLineTip | undefined): LineTip {
  if (tip === 'none' || tip === undefined) return 'none';
  return tip === 'right' || tip === 'triangle' ? 'right' : 'stealth';
}

export function lineTips(vector: VectorGeometry) {
  const legacy = vector.tool === 'arrow' ? vector.tip ?? 'triangle' : 'none';
  return {
    start: normalizeTip(vector.startTip ?? (legacy === 'both' ? 'triangle' : 'none')),
    end: normalizeTip(vector.endTip ?? (legacy === 'both' ? 'triangle' : legacy)),
    scale: vector.tipScale ?? 1,
  };
}

/** Distancia (unidades de usuario) que el cuerpo de la línea debe retroceder desde el vértice. */
function tipInset(tip: LineTip, scale: number) {
  if (tip === 'none') return 0;
  return TIP_LENGTH * scale * VECTOR_STROKE_WIDTH * (tip === 'stealth' ? STEALTH_NOTCH : 1);
}

function tipMarker(id: string, tip: LineTip, scale: number) {
  if (tip === 'none') return '';
  const L = TIP_LENGTH * scale;
  const W = TIP_HALF_WIDTH * scale;
  const d = tip === 'stealth'
    ? `M 0,0 L ${-L},${-W} L ${-STEALTH_NOTCH * L},0 L ${-L},${W} Z`
    : `M 0,0 L ${-L},${-W} L ${-L},${W} Z`;
  return `<marker id="${id}" markerUnits="strokeWidth" markerWidth="1" markerHeight="1" refX="0" refY="0" orient="auto-start-reverse" overflow="visible">`
    + `<path d="${d}" fill="context-stroke" stroke="context-stroke" stroke-width="0.01" stroke-linejoin="miter" stroke-miterlimit="10"/></marker>`;
}

/** Recorta el cuerpo de la línea en la muesca/base de cada punta, con corte recto. */
function bodyClip(start: Vertex, end: Vertex, startInset: number, endInset: number) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length || (!startInset && !endInset)) return '';
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const from = Math.min(startInset, length);
  const to = Math.max(from, length - endInset);
  const half = 1e4;
  const at = (t: number, k: number) => `${(start.x + ux * t + nx * k).toFixed(4)},${(start.y + uy * t + ny * k).toFixed(4)}`;
  const points = [at(from, -half), at(to, -half), at(to, half), at(from, half)].join(' ');
  return `<clipPath id="tip-clip" clipPathUnits="userSpaceOnUse"><polygon points="${points}"/></clipPath>`;
}

export function vectorSvg(vector: VectorGeometry, width: number, height: number) {
  const { tool, reverseX, reverseY, text, textStyle } = vector;
  const [start, end] = vector.endpoints ?? [
    { x: width <= 1 ? 0.5 : reverseX ? width : 0, y: height <= 1 ? 0.5 : reverseY ? height : 0 },
    { x: width <= 1 ? 0.5 : reverseX ? 0 : width, y: height <= 1 ? 0.5 : reverseY ? 0 : height },
  ];
  const fill = `fill="${VECTOR_FILL}"`;
  const stroke = `stroke="${VECTOR_STROKE}" stroke-width="${VECTOR_STROKE_WIDTH}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"`;
  const tips = lineTips(vector);
  const linear = tool === 'line' || tool === 'arrow';
  const clip = linear ? bodyClip(start, end, tipInset(tips.start, tips.scale), tipInset(tips.end, tips.scale)) : '';
  const markers = linear
    ? tipMarker('tip-start', tips.start, tips.scale) + tipMarker('tip-end', tips.end, tips.scale) + clip
    : '';
  const heads = markers ? `<defs>${markers}</defs>` : '';
  const line = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" ${stroke}${tips.start !== 'none' ? ' marker-start="url(#tip-start)"' : ''}${tips.end !== 'none' ? ' marker-end="url(#tip-end)"' : ''}${clip ? ' clip-path="url(#tip-clip)"' : ''}/>`;
  const markup = {
    polygon: `<polygon points="${vector.vertices?.map(({ x, y }) => `${x},${y}`).join(' ') ?? ''}" ${fill}/>`,
    rectangle: `<rect width="${width}" height="${height}" ${fill}/>`,
    ellipse: `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${fill}/>`,
    line,
    arrow: line,
    text: textStyle
      ? `<text x="${textStyle.align === 'center' ? width / 2 : textStyle.align === 'right' ? width : 0}" y="${height * 0.8}" font-family="${fontStack(textStyle.fontFamily).replaceAll('"', '')}" font-size="${height}" font-weight="${textStyle.fontWeight}" font-style="${textStyle.italic ? 'italic' : 'normal'}" text-anchor="${textStyle.align === 'center' ? 'middle' : textStyle.align === 'right' ? 'end' : 'start'}" letter-spacing="${textStyle.letterSpacing}" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`
      : `<text x="0" y="${height * 0.8}" font-family="sans-serif" font-size="${height}" textLength="${width}" lengthAdjust="spacingAndGlyphs" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${Math.max(1, width)} ${Math.max(1, height)}" overflow="visible">${heads}${markup[tool]}</svg>`;
}
