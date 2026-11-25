import { DEFAULT_PLANE, type PlaneGeometry } from '../types';

/** Límite de líneas por dirección (cuadrícula principal + subcuadrícula): protege el DOM de rangos absurdos. */
const MAX_LINES = 400;
const HEX = /^#[\da-f]{3,8}$/i;
const SERIF = `'STIX Two Text','Latin Modern Roman','Times New Roman',Georgia,serif`;

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const f = (value: number) => String(Math.round(value * 1000) / 1000);
const clean = (value: number) => Math.round(value * 1e10) / 1e10;
const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Completa y sanea una geometría (archivos antiguos, entradas libres del inspector):
 * rangos con `max > min`, pasos positivos, subdivisiones enteras y colores hexadecimales válidos.
 */
export function normalizePlane(input: Partial<PlaneGeometry> = {}): PlaneGeometry {
  const d = DEFAULT_PLANE;
  const p = { ...d } as PlaneGeometry;
  for (const key of Object.keys(d) as (keyof PlaneGeometry)[]) {
    const value = input[key];
    if (value !== undefined && typeof value === typeof d[key]) (p as unknown as Record<string, unknown>)[key] = value;
  }
  p.width = clamp(finite(p.width, d.width), 20, 20000);
  p.height = clamp(finite(p.height, d.height), 20, 20000);
  p.xMin = finite(p.xMin, d.xMin);
  p.yMin = finite(p.yMin, d.yMin);
  p.xMax = finite(p.xMax, d.xMax) > p.xMin ? finite(p.xMax, d.xMax) : p.xMin + 1;
  p.yMax = finite(p.yMax, d.yMax) > p.yMin ? finite(p.yMax, d.yMax) : p.yMin + 1;
  p.xStep = finite(p.xStep, d.xStep) > 0 ? p.xStep : d.xStep;
  p.yStep = finite(p.yStep, d.yStep) > 0 ? p.yStep : d.yStep;
  p.subdivisions = clamp(Math.round(finite(p.subdivisions, d.subdivisions)), 1, 10);
  p.axisWidth = clamp(finite(p.axisWidth, d.axisWidth), 0, 40);
  p.gridWidth = clamp(finite(p.gridWidth, d.gridWidth), 0, 40);
  p.subGridWidth = clamp(finite(p.subGridWidth, d.subGridWidth), 0, 40);
  p.gridOpacity = clamp(finite(p.gridOpacity, d.gridOpacity), 0, 1);
  p.subGridOpacity = clamp(finite(p.subGridOpacity, d.subGridOpacity), 0, 1);
  p.tickLength = clamp(finite(p.tickLength, d.tickLength), 0, 200);
  p.numberSize = clamp(finite(p.numberSize, d.numberSize), 4, 200);
  for (const key of ['axisColor', 'gridColor', 'subGridColor', 'numberColor'] as const) {
    if (!HEX.test(p[key])) p[key] = d[key];
  }
  if (p.arrowTips !== 'both' && p.arrowTips !== 'positive' && p.arrowTips !== 'none') p.arrowTips = d.arrowTips;
  p.xLabel = p.xLabel.slice(0, 12);
  p.yLabel = p.yLabel.slice(0, 12);
  return p;
}

/** Decimales necesarios para escribir `step` sin pérdida (máx. 6), p. ej. 0.25 → 2, 1 → 0. */
function decimalsOf(step: number) {
  for (let d = 0; d < 6; d++) {
    const scale = 10 ** d;
    if (Math.abs(Math.round(step * scale) / scale - step) < 1e-9) return d;
  }
  return 6;
}

/** Etiqueta numérica limpia (sin `1.0000001`), con redondeo según el paso y signo tipográfico `−`. */
export function formatPlaneNumber(value: number, step: number) {
  const d = decimalsOf(step);
  const rounded = Number(value.toFixed(d));
  const text = Math.abs(rounded) >= 1e-6 || rounded === 0 ? String(rounded) : rounded.toFixed(d);
  return text.replace('-', '−');
}

/** Máximo de pasos principales por eje al dibujar; si el rango pide más, el paso se amplía a un valor «redondo». */
const MAX_MAIN_LINES = 100;

function drawableStep(min: number, max: number, step: number) {
  if ((max - min) / step <= MAX_MAIN_LINES) return step;
  const raw = (max - min) / MAX_MAIN_LINES;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
}

/** Valores del eje con su condición de «principal» (múltiplo del paso) o de subdivisión. */
function gridValues(min: number, max: number, step: number, subdivisions: number) {
  const sub = Math.min(subdivisions, Math.max(1, Math.floor(MAX_LINES / Math.max(1, (max - min) / step))));
  const fine = step / sub;
  const first = Math.ceil(min / fine - 1e-9);
  const last = Math.floor(max / fine + 1e-9);
  const out: { value: number; main: boolean }[] = [];
  for (let k = first; k <= last; k++) out.push({ value: clean(k * fine), main: k % sub === 0 });
  return out;
}

/** Profundidad de la muesca de la punta Stealth (fracción de su longitud). */
const NOTCH = 0.78;

/** Punta tipo Stealth (con muesca) que apunta en la dirección `theta` (rad, eje y hacia abajo). */
function stealthTip(x: number, y: number, theta: number, length: number, halfWidth: number) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const at = (back: number, side: number) => `${f(x - c * back - s * side)},${f(y - s * back + c * side)}`;
  return [at(0, 0), at(length, halfWidth), at(length * NOTCH, 0), at(length, -halfWidth)].join(' ');
}
/**
 * SVG del plano cartesiano en coordenadas del propio objeto (`0..width` × `0..height`).
 * Capas: subcuadrícula → cuadrícula → ejes (con ticks y puntas) → números y etiquetas.
 * Cada grupo lleva `data-mm-phase` (`grid` | `axis` | `label`) para el reveal escalonado de `Create`.
 */
export function planeSvg(plane: PlaneGeometry): string {
  const p = normalizePlane(plane);
  const W = p.width;
  const H = p.height;
  const sx = (x: number) => ((x - p.xMin) * W) / (p.xMax - p.xMin);
  const sy = (y: number) => H - ((y - p.yMin) * H) / (p.yMax - p.yMin);

  const xStep = drawableStep(p.xMin, p.xMax, p.xStep);
  const yStep = drawableStep(p.yMin, p.yMax, p.yStep);
  const xs = gridValues(p.xMin, p.xMax, xStep, p.subdivisions);
  const ys = gridValues(p.yMin, p.yMax, yStep, p.subdivisions);
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number, opacity: number, cap = 'butt') =>
    `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="${cap}" fill="none"/>`;

  const sub: string[] = [];
  const main: string[] = [];
  const grid = (values: typeof xs, vertical: boolean) => {
    for (const { value, main: isMain } of values) {
      const at = vertical ? sx(value) : sy(value);
      const [x1, y1, x2, y2] = vertical ? [at, 0, at, H] : [0, at, W, at];
      if (isMain && p.showGrid && p.gridWidth > 0) main.push(line(x1, y1, x2, y2, p.gridColor, p.gridWidth, p.gridOpacity));
      else if (!isMain && p.showSubGrid && p.subGridWidth > 0) sub.push(line(x1, y1, x2, y2, p.subGridColor, p.subGridWidth, p.subGridOpacity));
    }
  };
  grid(xs, true);
  grid(ys, false);

  // El eje se dibuja en su coordenada real o, si 0 queda fuera del intervalo, pegado al borde más cercano.
  const ax = sx(clamp(0, p.xMin, p.xMax));
  const ay = sy(clamp(0, p.yMin, p.yMax));
  const axis: string[] = [];
  const labels: string[] = [];
  if (p.showAxes) {
    const tipLength = Math.min(9 + 3.2 * p.axisWidth, Math.min(W, H) / 4);
    const halfWidth = tipLength * 0.38;
    const both = p.arrowTips === 'both';
    const any = p.arrowTips !== 'none';
    const inset = tipLength * NOTCH;
    axis.push(line(both ? inset : 0, ay, any ? W - inset : W, ay, p.axisColor, p.axisWidth, 1));
    axis.push(line(ax, any ? inset : 0, ax, both ? H - inset : H, p.axisColor, p.axisWidth, 1));
    // y crece hacia arriba: el extremo positivo del eje y es el borde superior (y = 0 en px).

    if (p.showTicks && p.tickLength > 0) {
      const half = p.tickLength / 2;
      const tickWidth = Math.max(1, p.axisWidth * 0.8);
      for (const { value, main: isMain } of xs) {
        if (!isMain || (value === 0 && p.xMin <= 0 && p.xMax >= 0)) continue;
        axis.push(line(sx(value), ay - half, sx(value), ay + half, p.axisColor, tickWidth, 1));
      }
      for (const { value, main: isMain } of ys) {
        if (!isMain || (value === 0 && p.yMin <= 0 && p.yMax >= 0)) continue;
        axis.push(line(ax - half, sy(value), ax + half, sy(value), p.axisColor, tickWidth, 1));
      }
    }
    if (any) {
      const tip = (x: number, y: number, theta: number, key: string) =>
        `<polygon data-mm-tip="${key}" points="${stealthTip(x, y, theta, tipLength, halfWidth)}" fill="${p.axisColor}" stroke="none"/>`;
      axis.push(tip(W, ay, 0, 'x'), tip(ax, 0, -Math.PI / 2, 'y'));
      if (both) axis.push(tip(0, ay, Math.PI, 'x0'), tip(ax, H, Math.PI / 2, 'y0'));
    }

    const text = (x: number, y: number, anchor: string, size: number, color: string, content: string, italic = false) =>
      `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="${SERIF}" font-size="${f(size)}"${italic ? ' font-style="italic"' : ''} fill="${color}" xml:space="preserve">${escapeXml(content)}</text>`;
    const half = p.showTicks ? p.tickLength / 2 : 0;
    if (p.showNumbers) {
      for (const { value, main: isMain } of xs) {
        if (!isMain || (value === 0 && p.xMin <= 0 && p.xMax >= 0)) continue;
        labels.push(text(sx(value), ay + half + 5 + p.numberSize * 0.76, 'middle', p.numberSize, p.numberColor, formatPlaneNumber(value, xStep)));
      }
      for (const { value, main: isMain } of ys) {
        if (!isMain || (value === 0 && p.yMin <= 0 && p.yMax >= 0)) continue;
        labels.push(text(ax - half - 6, sy(value) + p.numberSize * 0.34, 'end', p.numberSize, p.numberColor, formatPlaneNumber(value, yStep)));
      }
      const originVisible = p.xMin <= 0 && p.xMax >= 0 && p.yMin <= 0 && p.yMax >= 0;
      if (p.showOriginZero && originVisible) {
        labels.push(text(ax - half - 6, ay + half + 5 + p.numberSize * 0.76, 'end', p.numberSize, p.numberColor, '0'));
      }
    }
    if (p.showAxisLabels) {
      const size = p.numberSize * 1.5;
      if (p.xLabel.trim()) labels.push(text(W - 3, ay - Math.max(halfWidth, half) - 7, 'end', size, p.axisColor, p.xLabel.trim(), true));
      if (p.yLabel.trim()) labels.push(text(ax + Math.max(halfWidth, half) + 9, size * 0.85, 'start', size, p.axisColor, p.yLabel.trim(), true));
    }
  }

  const group = (phase: string, layer: string, items: string[]) =>
    items.length ? `<g data-mm-phase="${phase}" data-mm-layer="${layer}">${items.join('')}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${f(W)} ${f(H)}" overflow="visible">`
    + group('grid', 'subGrid', sub) + group('grid', 'grid', main) + group('axis', 'axes', axis) + group('label', 'labels', labels)
    + '</svg>';
}
