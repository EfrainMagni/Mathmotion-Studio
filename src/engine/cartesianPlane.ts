import { DEFAULT_PLANE, type PlaneGeometry, type PlanePlot, type PlanePoint } from '../types';

/** Límite de líneas por dirección (cuadrícula principal + subcuadrícula): protege el DOM de rangos absurdos. */
const MAX_LINES = 400;
const PLOT_SAMPLES = 200;
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
  const plots = normalizePlots(input.plots);
  const points = normalizePoints(input.points);
  if (plots.length) p.plots = plots;
  else delete p.plots;
  if (points.length) p.points = points;
  else delete p.points;
  return p;
}

// ------------------------------------------------------------------ gráficas y puntos

export const PLOT_COLORS = ['#FFFF00', '#83C167', '#FF8080', '#FC6255', '#58C4DD'];
const ITEM_ID = /^[a-z]{1,3}\d{1,6}$/;
const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const hexOr = (value: unknown, fallback: string) => (typeof value === 'string' && HEX.test(value) ? value : fallback);

/** Identificadores únicos con prefijo (`f1`, `pt2`…): se reasignan si faltan, son inválidos o están repetidos. */
function uniqueId(raw: unknown, prefix: string, taken: Set<string>) {
  if (typeof raw === 'string' && ITEM_ID.test(raw) && !taken.has(raw)) return raw;
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function normalizePlots(input: unknown): PlanePlot[] {
  if (!Array.isArray(input)) return [];
  const taken = new Set<string>();
  const out: PlanePlot[] = [];
  for (const item of input.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const id = uniqueId(item.id, 'f', taken);
    taken.add(id);
    out.push({
      id, expression: typeof item.expression === 'string' ? item.expression.slice(0, 200) : '',
      color: hexOr(item.color, PLOT_COLORS[0]), width: clamp(finite(item.width, 3), 0.5, 40),
      xStart: optionalNumber(item.xStart), xEnd: optionalNumber(item.xEnd), visible: item.visible !== false,
    });
  }
  return out;
}

function normalizePoints(input: unknown): PlanePoint[] {
  if (!Array.isArray(input)) return [];
  const taken = new Set<string>();
  const out: PlanePoint[] = [];
  for (const item of input.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const id = uniqueId(item.id, 'pt', taken);
    taken.add(id);
    out.push({
      id, x: finite(item.x, 0), y: finite(item.y, 0), color: hexOr(item.color, '#FF8080'),
      radius: clamp(finite(item.radius, 5), 1, 60),
      label: typeof item.label === 'string' && item.label.trim() ? item.label.slice(0, 24) : undefined,
      showGuideLines: item.showGuideLines === true ? true : undefined, visible: item.visible !== false,
    });
  }
  return out;
}

const nextId = (items: { id: string }[] | undefined, prefix: string) =>
  `${prefix}${(items ?? []).reduce((max, item) => Math.max(max, Number(item.id.replace(/\D/g, '')) || 0), 0) + 1}`;

/** Gráfica nueva (recta `x` por defecto) con el siguiente color de la paleta. */
export function newPlot(plane: PlaneGeometry): PlanePlot {
  const plots = plane.plots ?? [];
  return { id: nextId(plots, 'f'), expression: 'x', color: PLOT_COLORS[plots.length % PLOT_COLORS.length], width: 3, visible: true };
}

/** Punto nuevo en el origen (o en el centro del rango si el origen queda fuera). */
export function newPoint(plane: PlaneGeometry): PlanePoint {
  const p = normalizePlane(plane);
  const inside = p.xMin <= 0 && p.xMax >= 0 && p.yMin <= 0 && p.yMax >= 0;
  return {
    id: nextId(p.points, 'pt'), x: inside ? 0 : clean((p.xMin + p.xMax) / 2), y: inside ? 0 : clean((p.yMin + p.yMax) / 2),
    color: '#FF8080', radius: 5, visible: true,
  };
}

// ------------------------------------------------------------------ evaluador matemático seguro (sin eval)

type Ast =
  | { t: 'num'; v: number }
  | { t: 'const'; name: 'pi' | 'e' }
  | { t: 'x' }
  | { t: 'neg'; a: Ast }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Ast; b: Ast }
  | { t: 'fn'; name: FnName; a: Ast };
type FnName = 'sin' | 'cos' | 'tan' | 'sqrt' | 'abs' | 'ln' | 'log' | 'exp';
type Token = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string };

const FUNCTIONS: Record<FnName, (value: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, exp: Math.exp,
};
const PYTHON_FN: Record<FnName, string> = {
  sin: 'np.sin', cos: 'np.cos', tan: 'np.tan', sqrt: 'np.sqrt', abs: 'np.abs', ln: 'np.log', log: 'np.log10', exp: 'np.exp',
};
const KNOWN_NAMES = ['sqrt', 'sin', 'cos', 'tan', 'abs', 'exp', 'log', 'ln', 'pi', '\u03c0', 'e', 'x'];
const MAX_EXPRESSION = 200;
const MAX_DEPTH = 60;

/** Parte «xsin» en [«x», «sin»] y «pix» en [«pi», «x»]; `null` si hay letras desconocidas. */
function splitName(text: string): string[] | null {
  if (!text) return [];
  for (const name of KNOWN_NAMES) {
    if (!text.startsWith(name)) continue;
    const rest = splitName(text.slice(name.length));
    if (rest) return [name, ...rest];
  }
  return null;
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    const number = /^(?:\d+\.?\d*|\.\d+)/.exec(source.slice(i));
    if (number) { tokens.push({ k: 'num', v: Number(number[0]) }); i += number[0].length; continue; }
    const word = /^[A-Za-z\u03c0]+/.exec(source.slice(i));
    if (word) {
      const parts = splitName(word[0].toLowerCase());
      if (!parts) return null;
      for (const part of parts) tokens.push({ k: 'id', v: part === '\u03c0' ? 'pi' : part });
      i += word[0].length;
      continue;
    }
    if (c === '*' && source[i + 1] === '*') { tokens.push({ k: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^()'.includes(c)) { tokens.push({ k: 'op', v: c }); i++; continue; }
    return null;
  }
  return tokens;
}

/** Analiza `expression` (variable `x`); `null` si no es válida. Admite multiplicación implícita (`2x`, `3(x+1)`, `x sin(x)`). */
function parseExpression(expression: string): Ast | null {
  if (!expression.trim() || expression.length > MAX_EXPRESSION) return null;
  const tokens = tokenize(expression);
  if (!tokens?.length) return null;
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (token: Token | undefined, value: string) => token?.k === 'op' && token.v === value;
  const fail = (): never => { throw new Error('expresión no válida'); };
  const guard = <T,>(fn: () => T): T => {
    if (++depth > MAX_DEPTH) fail();
    try { return fn(); } finally { depth--; }
  };

  const expr = (): Ast => guard(() => {
    let a = term();
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = (tokens[pos++] as { v: '+' | '-' }).v;
      a = { t: 'bin', op, a, b: term() };
    }
    return a;
  });
  const term = (): Ast => {
    let a = unary();
    for (;;) {
      const token = peek();
      if (isOp(token, '*') || isOp(token, '/')) {
        pos++;
        a = { t: 'bin', op: (token as { v: '*' | '/' }).v, a, b: unary() };
      } else if (token && (token.k === 'num' || token.k === 'id' || isOp(token, '('))) {
        a = { t: 'bin', op: '*', a, b: power() }; // multiplicación implícita
      } else return a;
    }
  };
  const unary = (): Ast => guard(() => {
    if (isOp(peek(), '-')) { pos++; return { t: 'neg', a: unary() }; }
    if (isOp(peek(), '+')) { pos++; return unary(); }
    return power();
  });
  const power = (): Ast => {
    const base = atom();
    if (isOp(peek(), '^')) { pos++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  };
  const atom = (): Ast => {
    const token = tokens[pos++];
    if (!token) return fail();
    if (token.k === 'num') return { t: 'num', v: token.v };
    if (isOp(token, '(')) {
      const inner = expr();
      if (!isOp(tokens[pos++], ')')) fail();
      return inner;
    }
    if (token.k === 'id') {
      if (token.v === 'x') return { t: 'x' };
      if (token.v === 'pi' || token.v === 'e') return { t: 'const', name: token.v };
      if (token.v in FUNCTIONS) {
        if (!isOp(tokens[pos++], '(')) fail();
        const arg = expr();
        if (!isOp(tokens[pos++], ')')) fail();
        return { t: 'fn', name: token.v as FnName, a: arg };
      }
    }
    return fail();
  };

  try {
    const ast = expr();
    return pos === tokens.length ? ast : null;
  } catch {
    return null;
  }
}

function evaluate(ast: Ast, x: number): number {
  switch (ast.t) {
    case 'num': return ast.v;
    case 'const': return ast.name === 'pi' ? Math.PI : Math.E;
    case 'x': return x;
    case 'neg': return -evaluate(ast.a, x);
    case 'fn': return FUNCTIONS[ast.name](evaluate(ast.a, x));
    case 'bin': {
      const a = evaluate(ast.a, x);
      const b = evaluate(ast.b, x);
      return ast.op === '+' ? a + b : ast.op === '-' ? a - b : ast.op === '*' ? a * b : ast.op === '/' ? a / b : Math.pow(a, b);
    }
  }
}

/** Función JavaScript de `x` para una expresión, o `null` si no es válida. No usa `eval` ni `Function`. */
export function compileExpression(expression: string): ((x: number) => number) | null {
  const ast = parseExpression(expression);
  return ast ? (x) => evaluate(ast, x) : null;
}

function toPython(ast: Ast): string {
  switch (ast.t) {
    case 'num': return String(ast.v);
    case 'const': return ast.name === 'pi' ? 'np.pi' : 'np.e';
    case 'x': return 'x';
    case 'neg': return `(-${toPython(ast.a)})`;
    case 'fn': return `${PYTHON_FN[ast.name]}(${toPython(ast.a)})`;
    case 'bin': return `(${toPython(ast.a)} ${ast.op === '^' ? '**' : ast.op} ${toPython(ast.b)})`;
  }
}

/** Cuerpo de `lambda x: ...` en Python (NumPy) equivalente a la expresión, o `null` si no es válida. */
export function expressionToPython(expression: string): string | null {
  const ast = parseExpression(expression);
  return ast ? toPython(ast) : null;
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

  // Gráficas f(x): ~200 muestras en [xStart, xEnd], cortes en asíntotas/indefinidos y recorte al área del plano.
  const plotPaths: string[] = [];
  for (const plot of p.plots ?? []) {
    const fn = plot.visible ? compileExpression(plot.expression) : null;
    const a = clamp(plot.xStart ?? p.xMin, p.xMin, p.xMax);
    const b = clamp(plot.xEnd ?? p.xMax, p.xMin, p.xMax);
    if (!fn || !(b > a) || plot.width <= 0) continue;
    let d = '';
    let connected = false;
    let previous: { y: number; py: number } | null = null;
    for (let i = 0; i <= PLOT_SAMPLES; i++) {
      const x = a + ((b - a) * i) / PLOT_SAMPLES;
      const y = fn(x);
      if (!Number.isFinite(y)) { connected = false; previous = null; continue; }
      const py = clamp(sy(y), -4 * H, 5 * H);
      // Salto de signo con gran desplazamiento vertical = asíntota: no se une con una línea vertical.
      if (previous && Math.sign(y) !== Math.sign(previous.y) && Math.abs(py - previous.py) > 1.5 * H) connected = false;
      d += `${connected ? 'L' : 'M'}${f(sx(x))} ${f(py)}`;
      connected = true;
      previous = { y, py };
    }
    if (d) plotPaths.push(`<path d="${d}" fill="none" stroke="${plot.color}" stroke-width="${plot.width}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  // Puntos (x, y) en píxeles reales del plano; los que quedan fuera del rango no se dibujan.
  const pointItems: string[] = [];
  const tolerance = 1e-9;
  for (const point of p.points ?? []) {
    if (!point.visible || point.x < p.xMin - tolerance || point.x > p.xMax + tolerance
      || point.y < p.yMin - tolerance || point.y > p.yMax + tolerance) continue;
    const cx = sx(point.x);
    const cy = sy(point.y);
    if (point.showGuideLines) {
      const dash = `stroke="${point.color}" stroke-width="1.4" stroke-opacity="0.85" stroke-dasharray="6 5" fill="none"`;
      pointItems.push(`<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(cx)}" y2="${f(ay)}" ${dash}/>`,
        `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(ax)}" y2="${f(cy)}" ${dash}/>`);
    }
    pointItems.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(point.radius)}" fill="${point.color}" stroke="none"/>`);
    if (point.label) {
      const size = p.numberSize * 1.3;
      pointItems.push(`<text x="${f(cx + point.radius + 4)}" y="${f(cy - point.radius - 3)}" text-anchor="start" font-family="${SERIF}" font-size="${f(size)}" fill="${point.color}" xml:space="preserve">${escapeXml(point.label)}</text>`);
    }
  }

  const group = (phase: string, layer: string, items: string[], extra = '') =>
    items.length ? `<g data-mm-phase="${phase}" data-mm-layer="${layer}"${extra}>${items.join('')}</g>` : '';
  const clip = plotPaths.length ? `<defs><clipPath id="plane-clip" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="${f(W)}" height="${f(H)}"/></clipPath></defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${f(W)} ${f(H)}" overflow="visible">`
    + clip + group('grid', 'subGrid', sub) + group('grid', 'grid', main) + group('axis', 'axes', axis) + group('label', 'labels', labels)
    + group('plot', 'plots', plotPaths, ' clip-path="url(#plane-clip)"') + group('point', 'points', pointItems)
    + '</svg>';
}
