import { STAGE_SIZES, disappearModeOf, focusEnvelope, focusSpecOf, groupTransformOf, indicateSpecOf, isEntranceClip, isPathTool, planeSubElementOf, type Box, type Clip, type GroupTransformSpec, type NodeStyle, type Obj2D, type Project, type Vertex } from '../types';
import { vertexAttributes, vertexGeometry } from './vertices';
import { arcAsPath, arcCircle, arcEndAngle, arcPoint, gradientId, gradientMarkup, isLinearVector, lineTips, pathLayout, tipLayout } from './vector';
import { SELECTABLE_SHAPES } from './svgImport';
import {
  clipGlyphs, connectorPlan, directedGlyphClips, directedTargets, entranceScope, findGlyphElements, glyphChar, glyphKey, glyphRuns, matchGlyphs, mixColor,
  type DirectedGlyphClip,
} from './glyphs';

/**
 * SceneRuntime: dueño del DOM del escenario (capa SVG, capa de efectos).
 *
 * Principio: el aspecto en el instante `t` es una función pura de (proyecto, t).
 * `renderAt(t)` parte siempre del estado base y aplica cada clip según su progreso,
 * de modo que avanzar, retroceder o saltar da siempre el mismo resultado.
 * El runtime no depende de GSAP: la línea de tiempo maestra (playback.ts) solo le dice qué `t` dibujar.
 */

const PAINT_SEL = 'path,line,circle,ellipse,rect,polyline,polygon,text';
const NON_RENDERED_SEL = 'defs,clipPath,mask,pattern,symbol,marker';
const GEOM_TAGS = new Set(['path', 'line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon']);
/** Ventanas de `Create` de un plano cartesiano (fracción del clip): cuadrícula → ejes → números → gráficas → puntos. */
const PLANE_PHASES: Record<string, [number, number]> = { grid: [0, 0.5], axis: [0.3, 0.75], label: [0.55, 0.9], plot: [0.5, 1], point: [0.75, 1] };

type Props = Record<string, string>;

export interface NodeInfo {
  id: string;
  name: string;
  tag: string;
  kind: 'root-svg' | 'formula' | 'group' | 'shape' | 'text';
  objId: string;
  isRoot: boolean;
}

/** Glifo de una fórmula: índice secuencial, carácter y caja local en px del objeto. */
export interface GlyphInfo {
  glyphId: string;
  index: number;
  char: string;
  box: Box;
}

export interface TreeNode {
  id: string;
  name: string;
  tag: string;
  children: TreeNode[];
}

export interface RuntimeEls {
  stage: HTMLElement;
  layer: HTMLElement;
  fx: SVGSVGElement;
}

export interface RuntimeHooks {
  onTree?: () => void;
}

interface NodeRec {
  id: string;
  objId: string;
  el: Element;
  tag: string;
  name: string;
  parent: string | null;
  children: string[];
  isRoot: boolean;
}

interface GlyphRec {
  index: number;
  el: Element;
  parent: SVGGraphicsElement;
  char: string;
  /** Clave de emparejamiento de TransformMatchingTex (carácter o forma). */
  key: string;
}

/** Geometría base de un glifo (medida sin animaciones). Las cajas están en px del objeto. */
interface GlyphGeo {
  box: Box;
  center: { x: number; y: number };
  /** Centro del glifo en el espacio de su padre (pivote de escala y giro). */
  pivot: { x: number; y: number };
  /** Espacio del padre → px del objeto. */
  ctm: DOMMatrix;
  flip: 1 | -1;
}

interface ObjRec {
  id: string;
  kind: 'svg' | 'formula';
  markup: string;
  wrapper: HTMLDivElement;
  svg: SVGSVGElement;
  rootId: string;
  lastCss: string;
  glyphs: GlyphRec[];
  geo: GlyphGeo[] | null;
}

interface GeomInfo {
  dashLen: number;
  len: number;
  fill: string;
  stroke: string;
  sw: number;
  fillOpacity: number;
  cw: number;
  isText: boolean;
}

interface NState {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rot: number;
  glow: number;
  glowColor: string;
  draw: number | null;
  /** `lag_ratio` de Write; `null` conserva el escalonado por defecto. */
  lag: number | null;
  /** Mezclas de color en orden de clip ([color destino, cantidad 0–1]): Indicate (pulso) y Cambiar Color (permanente). */
  fillMix: [string, number][];
  /**
   * El tercer valor marca los contornos explícitos (Cambiar Color, o el contorno de Indicate / Spotlight): pueden
   * hacer aparecer un contorno que era `none`.
   */
  strokeMix: [string, number, boolean][];
  /** Opacidad de relleno destino de Cambiar Color ([valor, cantidad]). */
  fillOpacityTo: [number, number][];
  /** Grosor de trazo destino (Cambiar Color, contorno de Indicate / Spotlight), en px del escenario ([valor, cantidad]). */
  strokeWidthTo: [number, number][];
}

/** Efecto de un glifo (dx, dy en px del objeto; el resto relativo al estado base). */
interface GState {
  opacity: number;
  dx: number;
  dy: number;
  sc: number;
  rot: number;
  mix: [string, number][];
  /** Contorno exterior del glifo (Cambiar Color, Indicate, Spotlight): color y grosor (px del escenario) con su cantidad. */
  strokeMix: [string, number, boolean][];
  strokeWidthTo: [number, number][];
  glow: number;
  glowColor: string;
}

/** Marco de Circumscribe o foco de FocusOn, dibujados en la capa de efectos. */
interface Frame {
  kind: 'circumscribe' | 'focus';
  targetId: string;
  glyphs: number[] | null;
  p: number;
  color: string;
  opacity: number;
}

interface Ring {
  targetId: string;
  p: number;
  color: string;
  max: number | null;
}

/** Pintura base de una figura (sin animaciones): colores CSS, opacidad de relleno y grosor en px del escenario. */
interface ShapePaint { fill: string; fillOpacity: number; stroke: string; strokeWidth: number }

/** Deformación de la figura principal de una transformación de grupo, dibujada en una capa propia. */
interface Morph {
  key: string;
  /** Objeto tras cuyo contenedor se inserta la capa (conserva el orden de apilado). */
  afterId: string;
  d: string;
  paint: ShapePaint;
}

/** Plan (cacheado) de una transformación de grupo: figura principal deformable, pares y sobrantes. */
interface GroupPlan {
  morph: { a: Obj2D; b: Obj2D; ptsA: Pt[]; ptsB: Pt[]; closed: boolean; paintA: ShapePaint; paintB: ShapePaint } | null;
  pairs: [Obj2D, Obj2D][];
  extraA: Obj2D[];
  extraB: Obj2D[];
}

type Pt = { x: number; y: number };
type GroupKind = 'shape' | 'point' | 'text' | 'tex' | 'line' | 'svg';

const GROUP_SHAPE_TOOLS = new Set(['polygon', 'rectangle', 'ellipse', 'pen', 'curve', 'arc']);
/** Muestras del contorno para figuras curvas (elipse, trazados). */
const OUTLINE_SAMPLES = 64;
const objSize = (o: Obj2D) => Math.sqrt(Math.max(1, o.bw * o.bh)) * Math.abs(o.scale || 1);

/** Inserta vértices sobre las aristas más largas hasta tener `n` (los vértices originales se conservan). */
function resampleOutline(pts: Pt[], n: number, closed: boolean): Pt[] {
  if (pts.length >= n || pts.length < 2) return pts.slice();
  const segs = closed ? pts.length : pts.length - 1;
  const lens = Array.from({ length: segs }, (_, i) => Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const extra = n - pts.length;
  const share = lens.map((l) => (l / total) * extra);
  const count = share.map(Math.floor);
  let left = extra - count.reduce((a, b) => a + b, 0);
  for (const i of share.map((v, i) => i).sort((a, b) => (share[b] - count[b]) - (share[a] - count[a]))) {
    if (left <= 0) break;
    count[i]++;
    left--;
  }
  const out: Pt[] = [];
  pts.forEach((a, i) => {
    out.push(a);
    if (i >= segs) return;
    const b = pts[(i + 1) % pts.length];
    for (let j = 1; j <= count[i]; j++) {
      const t = j / (count[i] + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  });
  return out;
}

/** Reordena `b` (giro cíclico y sentido) para que cada vértice viaje lo menos posible hacia su pareja de `a`. */
function alignOutline(a: Pt[], b: Pt[], closed: boolean): Pt[] {
  const n = a.length;
  const centroid = (list: Pt[]) => list.reduce((c, q) => ({ x: c.x + q.x / list.length, y: c.y + q.y / list.length }), { x: 0, y: 0 });
  const ca = centroid(a);
  const cb = centroid(b);
  let best = b;
  let bestCost = Infinity;
  for (const list of [b, b.slice().reverse()]) {
    for (let shift = 0; shift < (closed ? n : 1); shift++) {
      let cost = 0;
      for (let i = 0; i < n && cost < bestCost; i++) {
        const q = list[(i + shift) % n];
        cost += (q.x - cb.x - (a[i].x - ca.x)) ** 2 + (q.y - cb.y - (a[i].y - ca.y)) ** 2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = Array.from({ length: n }, (_, i) => list[(i + shift) % n]);
      }
    }
  }
  return best;
}

/** Mezcla dos pinturas; `none` se trata como el color del otro extremo con opacidad 0. */
function mixPaint(a: ShapePaint, b: ShapePaint, t: number): ShapePaint {
  const channel = (ca: string, cb: string): [string, number, number] => {
    const na = ca === 'none' || !ca;
    const nb = cb === 'none' || !cb;
    if (na && nb) return ['none', 0, 0];
    if (na) return [cb, 0, 1];
    if (nb) return [ca, 1, 0];
    return [mixColor(ca, cb, t), 1, 1];
  };
  const [fill, fa, fb] = channel(a.fill, b.fill);
  const [stroke, sa, sb] = channel(a.stroke, b.stroke);
  const fillOpacity = (a.fillOpacity * fa) + (b.fillOpacity * fb - a.fillOpacity * fa) * t;
  const strokeWidth = a.strokeWidth * sa + (b.strokeWidth * sb - a.strokeWidth * sa) * t;
  return { fill, fillOpacity, stroke, strokeWidth };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
/** `smooth` de Manim (sigmoide con inflexión 10). */
export const smooth = (p: number) => {
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const err = sig(-5);
  return Math.min(1, Math.max(0, (sig(10 * (p - 0.5)) - err) / (1 - 2 * err)));
};
export const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);
/** Color hexadecimal con transparencia (`rgba`), para que un resplandor nazca y se apague sin saltos. */
const withAlpha = (color: string, alpha: number) => {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color);
  if (!m) return color;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const ch = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${ch(0)},${ch(2)},${ch(4)},${clamp01(alpha).toFixed(3)})`;
};

export class SceneRuntime {
  time = 0;
  private project: Project | null = null;
  private objs = new Map<string, ObjRec>();
  private nodes = new Map<string, NodeRec>();
  private k = 1;
  private applied = new Map<Element, Props>();
  /** Copias visuales de la ecuación origen (opción «Mantener ecuación origen»). */
  private ghosts = new Map<string, { src: ObjRec; wrapper: HTMLDivElement; svg: SVGSVGElement }>();
  private origInline = new WeakMap<Element, Map<string, string>>();
  private baseOp = new WeakMap<Element, number>();
  private geomCache = new WeakMap<Element, GeomInfo>();
  private vertexEdits = new Map<string, { element: Element; original: Element; points: Vertex[]; keys: string[] }>();
  private pivots = new WeakMap<Element, { x: number; y: number }>();
  private measureKey = '';
  /** Sub-elementos de plano (`plot:f1`…) con clip de entrada propio, por objeto: el clip del plano no los anima. */
  private ownedSubs = new Map<string, Set<string>>();
  private ringsDrawn = false;
  private matches = new Map<string, [number, number][]>();
  /** Planes de las transformaciones de grupo (emparejamiento y contornos), por firma de los objetos implicados. */
  private groupPlans = new Map<string, GroupPlan>();
  /** Capas de deformación de figuras (transformación de grupo en curso), por clip. */
  private morphEls = new Map<string, { wrapper: HTMLDivElement; svg: SVGSVGElement; path: SVGPathElement }>();

  constructor(
    private els: RuntimeEls,
    private hooks: RuntimeHooks = {},
  ) {}

  /** Escala CSS actual del escenario (vista previa reducida). Solo afecta a medidas del contorno de dibujo. */
  setScale(k: number) {
    this.k = k;
  }

  /**
   * Instantánea síncrona del escenario para la grabación directa a canvas: un único SVG con las
   * capas 2D (posición, rotación, escala, opacidad y brillo ya aplicados) más las capas de efectos,
   */
  snapshotScene(W: number, H: number, safe = false): { svg: string } {
    const ser = new XMLSerializer();
    const parts: string[] = [];
    // Propiedades que en la copia aislada (imagen SVG) ya no heredan las hojas de estilo de la página.
    const INLINE = [
      'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
      'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
      'text-anchor', 'visibility', 'display',
      // Contorno exterior de glifos (Cambiar Color con grosor): el trazo se pinta debajo del relleno.
      'paint-order', 'letter-spacing',
    ];
    for (const wrapper of Array.from(this.els.layer.children) as HTMLElement[]) {
      const live = wrapper.firstElementChild as SVGSVGElement | null;
      if (!live || !wrapper.classList.contains('mm-obj')) continue;
      const cs = getComputedStyle(wrapper);
      const op = parseFloat(wrapper.style.opacity || '1');
      if (cs.display === 'none' || op <= 0) continue;
      const bw = parseFloat(wrapper.style.width) || wrapper.offsetWidth;
      const bh = parseFloat(wrapper.style.height) || wrapper.offsetHeight;
      // Se trabaja sobre una copia: los estilos calculados se incrustan en ella (el SVG vivo no se toca).
      const svg = live.cloneNode(true) as SVGSVGElement;
      svg.setAttribute('width', String(bw));
      svg.setAttribute('height', String(bh));
      if (wrapper.dataset.kind === 'formula') svg.setAttribute('overflow', 'visible');
      const src = [live, ...Array.from(live.querySelectorAll('*'))];
      const dst = [svg, ...Array.from(svg.querySelectorAll('*'))];
      src.forEach((el, i) => {
        const copy = dst[i] as SVGElement | undefined;
        if (!copy || el.closest(NON_RENDERED_SEL)) return;
        if (safe && (el.localName === 'foreignObject' || el.localName === 'image')) {
          copy.remove();
          return;
        }
        const ecs = getComputedStyle(el);
        for (const prop of INLINE) {
          const v = ecs.getPropertyValue(prop);
          if (v) copy.style.setProperty(prop, v);
        }
        if (safe) copy.style.removeProperty('filter');
      });
      const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
      const ox = bw / 2;
      const oy = bh / 2;
      const filter = !safe && wrapper.style.filter ? `filter:${wrapper.style.filter};` : '';
      parts.push(
        `<g transform="translate(${ox} ${oy}) matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f}) translate(${-ox} ${-oy})" ` +
          `opacity="${op}" style="color:${cs.color};${filter}">${ser.serializeToString(svg)}</g>`,
      );
    }
    for (const child of Array.from(this.els.fx.children)) parts.push(ser.serializeToString(child));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
    return { svg };
  }

  // ------------------------------------------------------------------ proyecto

  setProject(p: Project) {
    this.project = p;
    const list = p.objects;
    const ids = new Set(list.map((o) => o.id));
    let treeChanged = false;

    for (const [id, rec] of this.objs) {
      if (!ids.has(id)) {
        this.unmount(rec);
        this.objs.delete(id);
        treeChanged = true;
      }
    }
    for (const o of list) {
      let rec = this.objs.get(o.id);
      if (!rec || rec.markup !== o.markup) {
        if (rec) this.unmount(rec);
        rec = this.mount(o);
        this.objs.set(o.id, rec);
        treeChanged = true;
      }
      rec.wrapper.style.width = `${o.bw}px`;
      rec.wrapper.style.height = `${o.bh}px`;
    }
    list.forEach((o, i) => {
      const w = this.objs.get(o.id)!.wrapper;
      if (this.els.layer.children[i] !== w) this.els.layer.insertBefore(w, this.els.layer.children[i] ?? null);
    });

    const { w, h } = STAGE_SIZES[p.format];
    this.els.stage.style.width = `${w}px`;
    this.els.stage.style.height = `${h}px`;

    this.syncVertexEdits(p.styles);
    this.renderAt(this.time);
    if (treeChanged) this.hooks.onTree?.();
  }

  private syncVertexEdits(styles: Project['styles']) {
    const invalidate = (element: Element) => {
      this.geomCache.delete(element);
      for (let node: Element | null = element; node && node.localName !== 'svg'; node = node.parentElement) {
        this.pivots.delete(node);
      }
    };
    for (const [id, edit] of this.vertexEdits) {
      const live = this.nodes.get(id)?.el === edit.element;
      if (live && styles[id]?.vertices === edit.points) continue;
      if (live) {
        for (const key of edit.keys) {
          const original = edit.original.getAttribute(key);
          if (original === null) edit.element.removeAttribute(key);
          else edit.element.setAttribute(key, original);
        }
        invalidate(edit.element);
      }
      this.vertexEdits.delete(id);
    }
    for (const [id, style] of Object.entries(styles)) {
      const element = this.nodes.get(id)?.el;
      if (!style.vertices || !element || this.vertexEdits.has(id)) continue;
      const attributes = vertexAttributes(element, style.vertices);
      if (!attributes) continue;
      const original = element.cloneNode(false) as Element;
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      this.vertexEdits.set(id, { element, original, points: style.vertices, keys: Object.keys(attributes) });
      invalidate(element);
    }
  }

  private mount(o: Obj2D): ObjRec {
    const doc = new DOMParser().parseFromString(o.markup, 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    const wrapper = document.createElement('div');
    wrapper.className = 'mm-obj';
    wrapper.dataset.mmObj = o.id;
    wrapper.dataset.kind = o.kind;
    wrapper.appendChild(svg);
    this.els.layer.appendChild(wrapper);

    const rootNode: NodeRec = {
      id: o.id,
      objId: o.id,
      el: wrapper,
      tag: 'svg',
      name: o.name,
      parent: null,
      children: [],
      isRoot: true,
    };
    this.nodes.set(o.id, rootNode);
    if (o.kind === 'svg') {
      svg.querySelectorAll('[data-mm-id]').forEach((el) => {
        const id = el.getAttribute('data-mm-id')!;
        const parentEl = el.parentElement?.closest('[data-mm-id]') ?? null;
        const parent = parentEl ? parentEl.getAttribute('data-mm-id')! : o.id;
        const rec: NodeRec = {
          id,
          objId: o.id,
          el,
          tag: el.localName.toLowerCase(),
          name: el.getAttribute('data-mm-name') ?? el.localName,
          parent,
          children: [],
          isRoot: false,
        };
        this.nodes.set(id, rec);
        this.nodes.get(parent)?.children.push(id);
      });
    }
    this.restoreAll();
    this.matches.clear();
    const glyphs: GlyphRec[] = o.kind === 'formula' && !o.vector
      ? findGlyphElements(svg).map((el, index) => {
          el.setAttribute('data-mm-glyph', String(index));
          return { index, el, parent: el.parentNode as SVGGraphicsElement, char: glyphChar(el), key: glyphKey(el) };
        })
      : [];
    return { id: o.id, kind: o.kind, markup: o.markup, wrapper, svg, rootId: o.id, lastCss: '', glyphs, geo: null };
  }

  private unmount(rec: ObjRec) {
    for (const [id, n] of this.nodes) if (n.objId === rec.id) this.nodes.delete(id);
    rec.wrapper.remove();
    this.restoreAll();
  }

  /** Vuelve al estado base del escenario (sin props de animación aplicadas). */
  resetBase() {
    this.restoreAll();
    this.geomCache = new WeakMap();
    for (const rec of this.objs.values()) rec.lastCss = '';
  }

  private restoreAll() {
    for (const [el, props] of this.applied) for (const k of Object.keys(props)) this.restoreProp(el, k);
    this.applied.clear();
  }

  private restoreProp(el: Element, k: string) {
    const st = (el as HTMLElement).style;
    const orig = this.origInline.get(el)?.get(k);
    if (orig) st.setProperty(k, orig);
    else st.removeProperty(k);
  }

  // ------------------------------------------------------------------ consultas

  getNodeInfo(id: string): NodeInfo | null {
    const n = this.nodes.get(id);
    if (n) {
      const rec = this.objs.get(n.objId);
      const kind: NodeInfo['kind'] = n.isRoot
        ? rec?.kind === 'formula'
          ? 'formula'
          : 'root-svg'
        : n.tag === 'g'
          ? 'group'
          : n.tag === 'text'
            ? 'text'
            : 'shape';
      return { id, name: n.name, tag: n.tag, kind, objId: n.objId, isRoot: n.isRoot };
    }
    return null;
  }

  getTree(objId: string): TreeNode | null {
    const root = this.nodes.get(objId);
    if (!root) return null;
    const build = (n: NodeRec): TreeNode => ({
      id: n.id,
      name: n.name,
      tag: n.tag,
      children: n.children.map((c) => build(this.nodes.get(c)!)),
    });
    return build(root);
  }

  getAncestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id)?.parent ?? null;
    while (cur) {
      out.push(cur);
      cur = this.nodes.get(cur)?.parent ?? null;
    }
    return out;
  }

  /** Nombre legible de cualquier id de nodo u objeto (para la línea de tiempo). */
  nameOf(id: string): string {
    const n = this.nodes.get(id);
    if (n) {
      if (n.isRoot) return n.name;
      const root = this.nodes.get(n.objId);
      return `${root?.name ?? n.objId} › ${n.name}`;
    }
    return this.project?.objects.find((o) => o.id === id)?.name ?? id;
  }

  /**
   * Traduce el destino de un evento de puntero al id del nodo seleccionable.
   * Un clic llega siempre al elemento hijo; Mayús selecciona el objeto completo.
   */
  resolveTarget(target: EventTarget | null, shift: boolean): string | null {
    if (!(target instanceof Element)) return null;
    const wrapper = target.closest('[data-mm-obj]') as HTMLElement | null;
    if (!wrapper) return null;
    const objId = wrapper.dataset.mmObj!;
    const rec = this.objs.get(objId);
    if (!rec || rec.kind === 'formula' || shift || this.project?.objects.some((o) => o.id === objId && (o.vector || o.plane))) return objId;
    let el: Element | null = target;
    while (el && el !== rec.svg) {
      const id = el.getAttribute('data-mm-id');
      if (id && this.nodes.has(id) && SELECTABLE_SHAPES.has(el.localName.toLowerCase())) return id;
      el = el.parentElement;
    }
    return objId;
  }

  getVertexTarget(id: string, linesOnly = false): {
    id: string; native: Obj2D | null; points: Vertex[]; matrix: DOMMatrix; linear: boolean; path?: boolean; arc?: boolean;
  } | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const object = this.project?.objects.find((entry) => entry.id === node.objId);
    if (!object || object.kind === 'formula') return null;
    const svg = this.objs.get(node.objId)?.svg;
    // Arco circular: manejadores de inicio y fin (con Selección y con Selección Directa).
    if (object.vector?.tool === 'arc' && object.vector.arc) {
      const matrix = svg?.querySelector<SVGGraphicsElement>('path')?.getScreenCTM();
      const { cx, cy, r } = arcCircle(object.bw, object.bh);
      const { startAngle, sweep } = object.vector.arc;
      const points = [arcPoint(cx, cy, r, startAngle), arcPoint(cx, cy, r, arcEndAngle(startAngle, sweep))];
      return matrix ? { id: object.id, native: object, points, matrix, linear: false, arc: true } : null;
    }
    // Trazados Bézier (pluma / curva suavizada): solo con Selección Directa; los puntos son los nodos.
    if (isPathTool(object.vector?.tool)) {
      if (linesOnly || !object.vector?.nodes?.length) return null;
      const matrix = svg?.querySelector<SVGGraphicsElement>('path')?.getScreenCTM();
      return matrix ? { id: object.id, native: object, points: object.vector.nodes.map(({ x, y }) => ({ x, y })), matrix, linear: false, path: true } : null;
    }
    const linear = object.vector?.tool === 'line' || object.vector?.tool === 'arrow';
    if (linear) {
      const element = svg?.querySelector('line');
      const matrix = element?.getScreenCTM();
      const points = element && vertexGeometry(element);
      return matrix && points?.length === 2 ? { id: object.id, native: object, points, matrix, linear: true } : null;
    }
    const native = object.vector?.tool === 'polygon' || object.vector?.tool === 'rectangle';
    if (native && !linesOnly) {
      const element = svg?.querySelector<SVGGraphicsElement>('polygon, rect');
      const matrix = element?.getScreenCTM();
      if (!matrix) return null;
      const points = object.vector?.vertices ?? [
        { x: 0, y: 0 }, { x: object.bw, y: 0 }, { x: object.bw, y: object.bh }, { x: 0, y: object.bh },
      ];
      return { id: object.id, native: object, points, matrix, linear: false };
    }
    if (object.vector || object.plane) return null;
    const element = (node.isRoot ? svg : node.el) as SVGGraphicsElement | undefined;
    if (!element) return null;
    const candidates = [element, ...element.querySelectorAll<SVGGraphicsElement>(
      linesOnly ? 'line' : 'polygon, polyline, line, path',
    )];
    const editable = candidates.flatMap((candidate) => {
      const target = candidate.getAttribute('data-mm-id');
      if (!target || !this.nodes.has(target) || (linesOnly && candidate.localName !== 'line')) return [];
      const points = vertexGeometry(candidate);
      return points && points.length <= 2048 ? [{ target, candidate, points }] : [];
    });
    if (editable.length !== 1) return null;
    const leaf = editable[0];
    const matrix = leaf.candidate.getScreenCTM();
    return matrix ? { id: leaf.target, native: null, points: leaf.points, matrix, linear: leaf.candidate.localName === 'line' } : null;
  }

  stageDeltaForNode(id: string, x: number, y: number) {
    const parent = this.nodes.get(id)?.el.parentElement as SVGGraphicsElement | undefined;
    const inv = parent?.getScreenCTM?.()?.inverse();
    if (!this.project || !inv) return { x, y };
    const rect = this.els.stage.getBoundingClientRect();
    const { w, h } = STAGE_SIZES[this.project.format];
    const dx = x * rect.width / w;
    const dy = y * rect.height / h;
    return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
  }

  /** Caja del nodo en coordenadas lógicas del escenario. */
  getBox(id: string): Box | null {
    const n = this.nodes.get(id);
    if (n) {
      const svg = n.isRoot ? this.objs.get(id)?.svg : undefined;
      const tool = this.project?.objects.find((object) => object.id === id)?.vector?.tool;
      const geometry = tool === 'line' || tool === 'arrow' ? 'line' : tool === 'polygon' ? 'polygon' : isPathTool(tool) || tool === 'arc' ? 'path' : null;
      const el = (geometry && svg?.querySelector(geometry)) || svg || n.el;
      const r = el.getBoundingClientRect();
      const sr = this.els.stage.getBoundingClientRect();
      if (!sr.width || !sr.height) return null;
      const { w, h } = STAGE_SIZES[this.project!.format];
      const kx = w / sr.width;
      const ky = h / sr.height;
      return { x: (r.left - sr.left) * kx, y: (r.top - sr.top) * ky, w: r.width * kx, h: r.height * ky };
    }
    return null;
  }

  /** Escala de "px de escenario por unidad local" del contenedor de `el`. */
  private localPerStage(el: Element): number {
    const parent = el.parentNode as SVGGraphicsElement | null;
    const m = parent && 'getScreenCTM' in parent ? parent.getScreenCTM() : null;
    if (!m) return 1;
    const sr = this.els.stage.getBoundingClientRect();
    const { w } = STAGE_SIZES[this.project!.format];
    const stageK = sr.width ? sr.width / w : this.k || 1;
    const s = Math.hypot(m.a, m.b) / stageK;
    return s > 1e-9 ? 1 / s : 1;
  }

  /** Relleno/trazo efectivos de un nodo, para mostrar en el inspector. */
  getPaint(id: string): { fill: string; stroke: string; strokeWidth: number } | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const root = n.isRoot ? this.objs.get(id)!.svg : n.el;
    const el = root.matches(PAINT_SEL) ? root : root.querySelector(PAINT_SEL);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fill: cs.fill, stroke: cs.stroke, strokeWidth: parseFloat(cs.strokeWidth) || 0 };
  }

  // ------------------------------------------------------------------ glifos

  private obj2d(id: string): Obj2D | undefined {
    const o = this.project?.objects.find((entry) => entry.id === id);
    return o;
  }

  private formulaOf(id: string): Obj2D | undefined {
    const o = this.obj2d(id);
    return o && o.kind === 'formula' && !o.vector && this.objs.get(id)?.glyphs.length ? o : undefined;
  }

  /** Mide una vez los glifos con el DOM en reposo. Devuelve null si aún no hay layout. */
  private geoOf(rec: ObjRec): GlyphGeo[] | null {
    if (rec.geo) return rec.geo;
    if (!rec.glyphs.length) return null;
    const geo: GlyphGeo[] = [];
    let measured = false;
    for (const g of rec.glyphs) {
      const el = g.el as unknown as SVGGraphicsElement;
      let bb: DOMRect | null = null;
      try {
        bb = el.getBBox();
      } catch {
        bb = null;
      }
      const rawCtm = g.parent.getCTM?.() ?? null;
      const ctm = rawCtm ? DOMMatrix.fromMatrix(rawCtm) : null;
      if (!bb || !ctm) {
        geo.push({ box: { x: 0, y: 0, w: 0, h: 0 }, center: { x: 0, y: 0 }, pivot: { x: 0, y: 0 }, ctm: new DOMMatrix(), flip: 1 });
        continue;
      }
      let own = new DOMMatrix();
      const list = el.transform?.baseVal;
      if (list) for (let i = 0; i < list.numberOfItems; i++) own = own.multiply(DOMMatrix.fromMatrix(list.getItem(i).matrix));
      const full = ctm.multiply(own);
      const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
        .map(([x, y]) => full.transformPoint({ x, y }));
      const xs = pts.map((pt) => pt.x);
      const ys = pts.map((pt) => pt.y);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const pivot = this.computePivot(el);
      const center = ctm.transformPoint(pivot);
      if (box.w > 0 || box.h > 0) measured = true;
      geo.push({ box, center: { x: center.x, y: center.y }, pivot, ctm, flip: ctm.a * ctm.d - ctm.b * ctm.c < 0 ? -1 : 1 });
    }
    if (!measured) return null;
    rec.geo = geo;
    return geo;
  }

  /** Glifos de una fórmula (para el inspector y el exportador). */
  getGlyphs(objId: string): GlyphInfo[] {
    const rec = this.objs.get(objId);
    if (!rec) return [];
    const geo = this.geoOf(rec);
    return rec.glyphs.map((g) => ({
      glyphId: `${objId}.g${g.index}`,
      index: g.index,
      char: g.char,
      box: geo ? geo[g.index].box : { x: 0, y: 0, w: 0, h: 0 },
    }));
  }

  /** Cajas actuales de cada glifo en coordenadas lógicas del escenario (null si no se ven). */
  getGlyphBoxes(objId: string): (Box | null)[] {
    const rec = this.objs.get(objId);
    if (!rec || !this.project) return [];
    const sr = this.els.stage.getBoundingClientRect();
    if (!sr.width || !sr.height) return rec.glyphs.map(() => null);
    const { w, h } = STAGE_SIZES[this.project.format];
    const kx = w / sr.width;
    const ky = h / sr.height;
    return rec.glyphs.map((g) => {
      const r = g.el.getBoundingClientRect();
      return r.width || r.height ? { x: (r.left - sr.left) * kx, y: (r.top - sr.top) * ky, w: r.width * kx, h: r.height * ky } : null;
    });
  }

  /** Glifo más cercano al punto (coordenadas de pantalla), con margen para trazos finos. */
  glyphAt(objId: string, clientX: number, clientY: number, pad = 4): number | null {
    const rec = this.objs.get(objId);
    if (!rec) return null;
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const g of rec.glyphs) {
      const r = g.el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (clientX < r.left - pad || clientX > r.right + pad || clientY < r.top - pad || clientY > r.bottom + pad) continue;
      const d = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
      if (d < bestDistance) {
        best = g.index;
        bestDistance = d;
      }
    }
    return best;
  }

  /** Caja actual (escenario) de un objeto o de un conjunto de sus glifos. */
  private selectionBox(objId: string, glyphs: number[] | null): Box | null {
    if (!glyphs) return this.getBox(objId);
    const boxes = this.getGlyphBoxes(objId);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of glyphs) {
      const b = boxes[i];
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Color base de una fórmula (sin overrides por glifo). */
  private baseColor(rec: ObjRec, rootFill: string | undefined): string {
    if (rootFill && rootFill !== 'none' && rootFill !== 'currentColor') return rootFill;
    return getComputedStyle(rec.svg).color || '#ffffff';
  }

  /** px del objeto → coordenadas lógicas del escenario (pose base del objeto). */
  private toStage(o: Obj2D, x: number, y: number) {
    const th = (o.rotation * Math.PI) / 180;
    const px = (x - o.bw / 2) * o.scale;
    const py = (y - o.bh / 2) * o.scale;
    return { x: o.x + px * Math.cos(th) - py * Math.sin(th), y: o.y + px * Math.sin(th) + py * Math.cos(th) };
  }

  /** Vector del escenario → px del objeto. */
  private stageVec(o: Obj2D, dx: number, dy: number) {
    const th = (-o.rotation * Math.PI) / 180;
    return { x: (dx * Math.cos(th) - dy * Math.sin(th)) / o.scale, y: (dx * Math.sin(th) + dy * Math.cos(th)) / o.scale };
  }

  /** Caja de un conjunto de glifos en coordenadas del escenario (pose base). */
  private stageBounds(o: Obj2D, geo: GlyphGeo[], idx: number[]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of idx) {
      const b = geo[i].box;
      for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
        const pt = this.toStage(o, x, y);
        x0 = Math.min(x0, pt.x);
        y0 = Math.min(y0, pt.y);
        x1 = Math.max(x1, pt.x);
        y1 = Math.max(y1, pt.y);
      }
    }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }

  // ------------------------------------------------------------------ medidas

  /** Líneas y flechas no tienen relleno: su degradado se aplica al trazo. */
  private gradientOnStroke(n: NodeRec): boolean {
    return n.isRoot && isLinearVector(this.project?.objects.find((o) => o.id === n.objId)?.vector);
  }

  /**
   * Mantiene un `<defs data-mm-grad>` por objeto con un `<linearGradient>`/`<radialGradient>` por cada nodo con degradado.
   * Vive dentro del SVG del objeto, de modo que `snapshotScene()` (y la grabación MP4) lo clonan junto con las formas.
   */
  private syncGradients(p: Project) {
    const perObject = new Map<string, string>();
    for (const [id, style] of Object.entries(p.styles)) {
      const g = style.fillGradient;
      const n = this.nodes.get(id);
      if (!g || g.mode === 'solid' || !n) continue;
      let box: { x: number; y: number; w: number; h: number } | undefined;
      if (this.gradientOnStroke(n)) {
        try {
          const b = (this.geomsOf(n)[0] as SVGGraphicsElement | undefined)?.getBBox();
          if (b) box = { x: b.x, y: b.y, w: b.width, h: b.height };
        } catch {
          /* sin caja medible: se usa objectBoundingBox */
        }
      }
      perObject.set(n.objId, (perObject.get(n.objId) ?? '') + gradientMarkup(gradientId(id), g, box));
    }
    for (const [objId, rec] of this.objs) {
      const markup = perObject.get(objId) ?? '';
      let defs = rec.svg.querySelector(':scope > defs[data-mm-grad]');
      if (!markup) {
        defs?.remove();
        continue;
      }
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.setAttribute('data-mm-grad', '');
        rec.svg.insertBefore(defs, rec.svg.firstChild);
      }
      if (defs.getAttribute('data-key') !== markup) {
        defs.innerHTML = markup;
        defs.setAttribute('data-key', markup);
      }
    }
  }

  private geomsOf(n: NodeRec): Element[] {
    const base = n.isRoot ? this.objs.get(n.id)!.svg : n.el;
    const list = base.matches(PAINT_SEL) ? [base] : Array.from(base.querySelectorAll(PAINT_SEL));
    return list.filter((e) => !e.closest(NON_RENDERED_SEL) && !e.hasAttribute('data-mm-tip'));
  }

  /**
   * Puntas de líneas/flechas: polígonos sólidos sin trazo (nunca reciben dasharray ni grosor).
   * Se recalculan con el grosor y el color efectivos del cuerpo y recortan el `<line>` en la muesca/base.
   */
  private syncTips(next: Map<Element, Props>, P: (el: Element) => Props) {
    for (const object of this.project?.objects ?? []) {
      const vector = object.vector;
      if (vector && isPathTool(vector.tool) && !vector.closed) {
        this.syncPathTips(object.id, vector, next, P);
        continue;
      }
      if (vector?.tool === 'arc') {
        this.syncPathTips(object.id, arcAsPath(vector, object.bw, object.bh), next, P);
        continue;
      }
      if (!vector || (vector.tool !== 'line' && vector.tool !== 'arrow')) continue;
      const svg = this.objs.get(object.id)?.svg;
      const line = svg?.querySelector('line');
      if (!svg || !line) continue;
      const num = (k: string) => Number(line.getAttribute(k)) || 0;
      const pr = next.get(line);
      const sw = pr?.['stroke-width'] !== undefined ? parseFloat(pr['stroke-width']) : this.geomInfo(line).sw;
      const layout = tipLayout({ x: num('x1'), y: num('y1') }, { x: num('x2'), y: num('y2') }, lineTips(vector), Number.isFinite(sw) && sw > 0 ? sw : 1);
      const color = pr?.stroke ?? this.geomInfo(line).stroke;
      for (const key of ['start', 'end'] as const) {
        const tip = svg.querySelector(`[data-mm-tip="${key}"]`);
        if (!tip) continue;
        const points = layout[key];
        if (points && tip.getAttribute('points') !== points) tip.setAttribute('points', points);
        if (color) P(tip).fill = color;
      }
      const clip = svg.querySelector('clipPath polygon');
      if (clip && layout.clip && clip.getAttribute('points') !== layout.clip) clip.setAttribute('points', layout.clip);
    }
  }

  /**
   * Mezclas de color de Indicate y Cambiar Color sobre la pintura efectiva (estilos del inspector incluidos).
   * Rellenos y trazos `none` no se tiñen, salvo el trazo de Cambiar Color, que aparece con su opacidad. Las puntas
   * de flecha (polígonos sin trazo) siguen al color del trazo.
   */
  /**
   * Trazo de Indicate / Cambiar Color sobre un elemento: color encadenado y, si se pide, grosor interpolado
   * (px del escenario → unidades locales). Si el elemento no tenía contorno, aparece con opacidad y grosor
   * crecientes; con grosor objetivo se usa `paint-order: stroke fill` y unión redondeada, de modo que el borde
   * crece hacia fuera sin comerse el relleno (letras de MathTex incluidas).
   */
  private applyStroke(el: Element, pr: Props, mixes: [string, number, boolean][], widths: [number, number][]) {
    const info = this.geomInfo(el);
    const stroke = pr.stroke ?? info.stroke;
    const paintable = !!stroke && stroke !== 'none' && stroke !== 'transparent' && !stroke.startsWith('url(');
    if (paintable) {
      pr.stroke = mixes.reduce((c, [to, a]) => (a > 0 ? mixColor(c, to, a) : c), stroke);
    } else {
      // Sin contorno previo: solo los contornos explícitos (Cambiar Color, contorno de Indicate / Spotlight) lo hacen
      // aparecer; los temporales nacen con grosor 0 y vuelven a 0 con su envolvente.
      const permanent = mixes.filter(([, a, reveal]) => reveal && a > 0);
      if (!permanent.length) return;
      pr.stroke = permanent[permanent.length - 1][0];
      if (!widths.length) pr['stroke-opacity'] = String(1 - permanent.reduce((k, [, a]) => k * (1 - a), 1));
    }
    if (!widths.length) return;
    const lps = this.localPerStage(el);
    const current = pr['stroke-width'] !== undefined ? parseFloat(pr['stroke-width']) : paintable ? info.sw : 0;
    const width = widths.reduce((v, [to, a]) => v + (to * lps - v) * a, Number.isFinite(current) ? current : 0);
    pr['stroke-width'] = String(Math.max(0, width));
    pr['paint-order'] = 'stroke fill';
    pr['stroke-linejoin'] = 'round';
  }

  private applyColorMix(states: Map<string, NState>, P: (el: Element) => Props) {
    const paintable = (c: string | undefined) => !!c && c !== 'none' && c !== 'transparent' && !c.startsWith('url(');
    const chain = (base: string, mixes: [string, number, boolean?][]) => mixes.reduce((c, [to, a]) => (a > 0 ? mixColor(c, to, a) : c), base);
    for (const [id, st] of states) {
      if (!st.fillMix.length && !st.strokeMix.length && !st.fillOpacityTo.length && !st.strokeWidthTo.length) continue;
      const n = this.nodes.get(id);
      if (!n) continue;
      for (const el of this.geomsOf(n)) {
        const pr = P(el);
        const info = this.geomInfo(el);
        const fill = pr.fill ?? info.fill;
        if (st.fillMix.length && paintable(fill)) pr.fill = chain(fill, st.fillMix);
        if (st.fillOpacityTo.length) {
          const base = pr['fill-opacity'] !== undefined ? parseFloat(pr['fill-opacity']) : info.fillOpacity;
          pr['fill-opacity'] = String(st.fillOpacityTo.reduce((v, [to, a]) => v + (to - v) * a, Number.isFinite(base) ? base : 1));
        }
        if (st.strokeMix.length) this.applyStroke(el, pr, st.strokeMix, st.strokeWidthTo);
      }
      const root = n.isRoot ? this.objs.get(id)?.svg : n.el;
      for (const tip of Array.from(root?.querySelectorAll('[data-mm-tip]') ?? [])) {
        const pr = P(tip);
        const base = pr.fill ?? this.geomInfo(tip).fill;
        if (paintable(base)) pr.fill = chain(base, st.strokeMix);
      }
    }
  }

  /** Trazado abierto: recalcula el recorte del cuerpo (`d`) y las puntas con el grosor y color efectivos. */
  private syncPathTips(id: string, vector: NonNullable<Obj2D['vector']>, next: Map<Element, Props>, P: (el: Element) => Props) {
    const svg = this.objs.get(id)?.svg;
    const path = svg?.querySelector('path');
    if (!svg || !path) return;
    const pr = next.get(path);
    const sw = pr?.['stroke-width'] !== undefined ? parseFloat(pr['stroke-width']) : this.geomInfo(path).sw;
    const layout = pathLayout(vector, Number.isFinite(sw) && sw > 0 ? sw : 1);
    if (layout.d && path.getAttribute('d') !== layout.d) path.setAttribute('d', layout.d);
    const color = pr?.stroke ?? this.geomInfo(path).stroke;
    for (const key of ['start', 'end'] as const) {
      const tip = svg.querySelector(`[data-mm-tip="${key}"]`);
      const points = layout[key];
      if (!tip) continue;
      if (points && tip.getAttribute('points') !== points) tip.setAttribute('points', points);
      if (color) P(tip).fill = color;
    }
  }

  private geomInfo(el: Element): GeomInfo {
    let g = this.geomCache.get(el);
    if (g) return g;
    const cs = getComputedStyle(el);
    const isText = el.localName === 'text';
    let len = 0;
    if (!isText && GEOM_TAGS.has(el.localName)) {
      try {
        len = (el as unknown as SVGGeometryElement).getTotalLength();
      } catch {
        len = 0;
      }
    }
    const pl = parseFloat(el.getAttribute('pathLength') ?? '');
    const m = (el as SVGGraphicsElement).getScreenCTM?.();
    const sr = this.els.stage.getBoundingClientRect();
    const { w } = STAGE_SIZES[this.project!.format];
    const stageK = sr.width ? sr.width / w : this.k || 1;
    const s = m ? Math.hypot(m.a, m.b) / stageK : 1;
    g = {
      len,
      dashLen: Number.isFinite(pl) && pl > 0 ? pl : len,
      fill: cs.fill,
      stroke: cs.stroke,
      sw: parseFloat(cs.strokeWidth) || 0,
      fillOpacity: Number.isFinite(parseFloat(cs.fillOpacity)) ? parseFloat(cs.fillOpacity) : 1,
      cw: 3 / (s > 1e-9 ? s : 1),
      isText,
    };
    this.geomCache.set(el, g);
    return g;
  }

  /**
   * Centro del elemento en el espacio de coordenadas de su padre (bbox local + atributo `transform`).
   * Se usa como pivote de rotación/escala: no se emplea `transform-origin` porque alteraría la
   * colocación de los elementos que ya traen un atributo `transform` (grupos de Illustrator).
   */
  private computePivot(el: Element): { x: number; y: number } {
    // Pivote explícito (p. ej. el centro de un punto de un plano cartesiano).
    const fixed = el.getAttribute('data-mm-pivot')?.split(',').map(Number);
    if (fixed?.length === 2 && fixed.every(Number.isFinite)) return { x: fixed[0], y: fixed[1] };
    const g = el as unknown as SVGGraphicsElement;
    let bb: DOMRect | null = null;
    try {
      bb = g.getBBox();
    } catch {
      bb = null;
    }
    if (!bb) return { x: 0, y: 0 };
    let m = new DOMMatrix();
    const list = g.transform?.baseVal;
    if (list) {
      for (let i = 0; i < list.numberOfItems; i++) m = m.multiply(DOMMatrix.fromMatrix(list.getItem(i).matrix));
    }
    const p = m.transformPoint({ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
    return { x: p.x, y: p.y };
  }

  private baseOpacity(el: Element): number {
    let v = this.baseOp.get(el);
    if (v === undefined) {
      const o = parseFloat(getComputedStyle(el).opacity);
      v = Number.isFinite(o) ? o : 1;
      this.baseOp.set(el, v);
    }
    return v;
  }

  // ------------------------------------------------------------------ render

  renderAt(t: number) {
    this.time = t;
    const p = this.project;
    if (!p) return;

    // Invalida medidas cuando cambian estilos de pintura o clips de dibujo.
    const key =
      p.objects.map((o) => `${o.id}:${o.markup.length}`).join('|') +
      '#' +
      Object.entries(p.styles)
        .map(([id, s]) => `${id}:${s.fill ?? ''},${s.stroke ?? ''},${s.strokeWidth ?? ''},${s.fillGradient?.mode ?? ''},${s.fillOpacity ?? ''}`)
        .join('|') +
      '#' +
      p.clips
        .filter((c) => c.type === 'draw')
        .map((c) => c.targetId)
        .join('|');
    if (key !== this.measureKey) {
      this.measureKey = key;
      this.restoreAll();
      this.geomCache = new WeakMap();
    }

    const { states, rings, glyphStates, frames, ghostStates, ghostGlyphs, hiddenIds, morphs } = this.computeStates(this.resolveSubClips(p.clips), t);

    // Pivotes: se miden con el DOM en estado base para que el resultado no dependa del historial.
    const childIds = new Set<string>();
    for (const id of states.keys()) childIds.add(id);
    for (const [id, s] of Object.entries(p.styles)) if (s.scale !== undefined || s.tx || s.ty || s.opacity !== undefined) childIds.add(id);
    const needPivot: NodeRec[] = [];
    for (const id of childIds) {
      const n = this.nodes.get(id);
      if (!n || n.isRoot || this.pivots.has(n.el)) continue;
      const sc = (p.styles[id]?.scale ?? 1) * (states.get(id)?.scale ?? 1);
      if (sc !== 1 || (states.get(id)?.rot ?? 0) !== 0) needPivot.push(n);
    }
    if (needPivot.length) {
      this.restoreAll();
      for (const n of needPivot) this.pivots.set(n.el, this.computePivot(n.el));
    }
    const next = new Map<Element, Props>();
    const P = (el: Element): Props => {
      let x = next.get(el);
      if (!x) next.set(el, (x = {}));
      return x;
    };
    const mul = (el: Element, key: 'opacity' | 'fill-opacity', v: number, base: number) => {
      const pr = P(el);
      const cur = pr[key] !== undefined ? parseFloat(pr[key]) : base;
      pr[key] = String(cur * v);
    };

    // 1) overrides de pintura del inspector (el más profundo gana)
    this.syncGradients(p);
    const styled = Object.entries(p.styles)
      .filter(([, s]) => s.fill !== undefined || s.fillGradient !== undefined || s.stroke !== undefined || s.strokeWidth !== undefined ||
        s.lineStyle !== undefined || s.dashGap !== undefined || s.lineCap !== undefined || s.lineJoin !== undefined || s.fillOpacity !== undefined)
      .map(([id]) => this.nodes.get(id))
      .filter((n): n is NodeRec => !!n);
    const depth = (n: NodeRec) => {
      let d = 0;
      let c = n.parent;
      while (c) {
        d++;
        c = this.nodes.get(c)?.parent ?? null;
      }
      return d;
    };
    styled.sort((a, b) => depth(a) - depth(b));
    const patterns = new Map<Element, Pick<NodeStyle, 'lineStyle' | 'dashGap' | 'lineCap'>>();
    for (const n of styled) {
      const s = p.styles[n.id];
      for (const el of this.geomsOf(n)) {
        const pr = P(el);
        const gradient = s.fillGradient && s.fillGradient.mode !== 'solid' ? `url(#${gradientId(n.id)})` : null;
        if (gradient && this.gradientOnStroke(n)) pr.stroke = gradient;
        else if (gradient) pr.fill = gradient;
        else if (s.fill !== undefined) pr.fill = s.fill;
        if (s.stroke !== undefined && !(gradient && this.gradientOnStroke(n))) pr.stroke = s.stroke;
        if (s.strokeWidth !== undefined) pr['stroke-width'] = String(s.strokeWidth);
        if (s.fillOpacity !== undefined && !(gradient && this.gradientOnStroke(n))) pr['fill-opacity'] = String(s.fillOpacity);
        if (s.lineJoin) {
          // Unión de esquinas independiente del relleno: afilada con límite clásico (10) o redondeada.
          pr['stroke-linejoin'] = s.lineJoin;
          if (s.lineJoin === 'miter') pr['stroke-miterlimit'] = '10';
        }
        if (s.lineStyle || s.dashGap !== undefined || s.lineCap) {
          const pattern = patterns.get(el) ?? {};
          if (s.lineStyle) pattern.lineStyle = s.lineStyle;
          if (s.dashGap !== undefined) pattern.dashGap = s.dashGap;
          if (s.lineCap) pattern.lineCap = s.lineCap;
          patterns.set(el, pattern);
        }
      }
    }
    for (const [el, { lineStyle, dashGap, lineCap }] of patterns) {
      const pr = P(el);
      const cap = lineCap ?? (lineStyle === 'dotted' ? 'round' : undefined);
      if (cap) pr['stroke-linecap'] = cap;
      if (lineStyle === 'solid') pr['stroke-dasharray'] = 'none';
      if (lineStyle === 'dashed' || lineStyle === 'dotted') {
        const width = Number(pr['stroke-width'] ?? this.geomInfo(el).sw) || 1;
        const dashed = lineStyle === 'dashed';
        const mark = dashed ? 3 * width : cap === 'butt' ? Math.max(1, width * 0.2) : 0;
        pr['stroke-dasharray'] = `${mark} ${dashGap ?? width * (dashed ? 2 : 2.5)}`;
      }
    }

    this.syncTips(next, P);
    this.applyColorMix(states, P);

    // 2) transformaciones, opacidad y resplandor por nodo hijo
    for (const id of childIds) {
      const n = this.nodes.get(id);
      if (!n || n.isRoot) continue;
      const st = states.get(id);
      const ov = p.styles[id];
      const lps = st && (st.dx || st.dy || st.glow > 0) ? this.localPerStage(n.el) : 1;
      const tx = (ov?.tx ?? 0) + (st ? st.dx * lps : 0);
      const ty = (ov?.ty ?? 0) + (st ? st.dy * lps : 0);
      const sc = (ov?.scale ?? 1) * (st?.scale ?? 1);
      const rot = st?.rot ?? 0;
      const pr = P(n.el);
      if (sc !== 1 || rot) {
        // T(t) · T(C) · R · S · T(-C): rotación y escala sobre el centro del propio elemento.
        const pv = this.pivots.get(n.el) ?? { x: 0, y: 0 };
        const th = (rot * Math.PI) / 180;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const ex = tx + pv.x - sc * (pv.x * cos - pv.y * sin);
        const ey = ty + pv.y - sc * (pv.x * sin + pv.y * cos);
        pr.translate = `${ex}px ${ey}px`;
        if (sc !== 1) pr.scale = String(sc);
        if (rot) pr.rotate = `${rot}deg`;
        pr['transform-box'] = 'view-box';
        pr['transform-origin'] = '0px 0px';
      } else if (tx || ty) {
        pr.translate = `${tx}px ${ty}px`;
      }
      const opacity = (st?.opacity ?? 1) * (ov?.opacity ?? 1);
      if (opacity !== 1) mul(n.el, 'opacity', opacity, this.baseOpacity(n.el));
      if (st && st.glow > 0) {
        const attr = n.el.getAttribute('filter');
        const base = attr && attr.startsWith('url(') ? attr + ' ' : '';
        const r = (6 + 30 * st.glow) * lps;
        pr.filter = `${base}drop-shadow(0 0 ${r.toFixed(2)}px ${st.glowColor}) brightness(${(1 + 0.25 * st.glow).toFixed(3)})`;
      }
    }

    // 2b) glifos de fórmulas: estilo propio + clips de énfasis y transformación
    const glyphFx = (o: Obj2D, rec: ObjRec, effects: Map<number, GState> | undefined, elOf: (g: GlyphRec) => Element | null) => {
      const geo = this.geoOf(rec);
      const base = this.baseColor(rec, p.styles[o.id]?.fill);
      for (const g of rec.glyphs) {
        const gel = elOf(g);
        if (!gel) continue;
        const style = o.glyphStyles?.[g.index];
        const fx = effects?.get(g.index);
        if (!style && !fx) continue;
        const pr = P(gel);
        const opacity = (style?.opacity ?? 1) * (fx?.opacity ?? 1);
        if (opacity !== 1) mul(gel, 'opacity', opacity, this.baseOpacity(gel));
        if (style?.color !== undefined || fx?.mix.length) {
          let color = style?.color ?? base;
          for (const [target, amount] of fx?.mix ?? []) color = mixColor(color, target, amount);
          const paint = gel.matches(PAINT_SEL) ? [gel] : Array.from(gel.querySelectorAll(PAINT_SEL));
          for (const el of paint) P(el).fill = color;
        }
        if (fx?.strokeMix.length) {
          const paint = gel.matches(PAINT_SEL) ? [gel] : Array.from(gel.querySelectorAll(PAINT_SEL));
          for (const el of paint) this.applyStroke(el, P(el), fx.strokeMix, fx.strokeWidthTo);
        }
        const sc = (style?.scale ?? 1) * (fx?.sc ?? 1);
        const gg = geo?.[g.index];
        if (!gg || !(sc !== 1 || fx?.dx || fx?.dy || fx?.rot || (fx && fx.glow > 0))) continue;
        const inv = gg.ctm.inverse();
        const dx = fx?.dx ?? 0;
        const dy = fx?.dy ?? 0;
        const rot = (fx?.rot ?? 0) * gg.flip;
        const th = (rot * Math.PI) / 180;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const ex = inv.a * dx + inv.c * dy + gg.pivot.x - sc * (gg.pivot.x * cos - gg.pivot.y * sin);
        const ey = inv.b * dx + inv.d * dy + gg.pivot.y - sc * (gg.pivot.x * sin + gg.pivot.y * cos);
        if (sc !== 1 || rot || dx || dy) {
          pr.translate = `${ex}px ${ey}px`;
          if (sc !== 1) pr.scale = String(sc);
          if (rot) pr.rotate = `${rot}deg`;
          pr['transform-box'] = 'view-box';
          pr['transform-origin'] = '0px 0px';
        }
        if (fx && fx.glow > 0) {
          const local = 1 / ((Math.hypot(gg.ctm.a, gg.ctm.b) || 1) * o.scale);
          pr.filter = `drop-shadow(0 0 ${((4 + 22 * fx.glow) * local).toFixed(2)}px ${fx.glowColor}) brightness(${(1 + 0.2 * fx.glow).toFixed(3)})`;
        }
      }
    };
    for (const o of p.objects) {
      if (o.kind !== 'formula') continue;
      const rec = this.objs.get(o.id);
      const effects = glyphStates.get(o.id);
      if (!rec || !rec.glyphs.length || (!o.glyphStyles && !effects)) continue;
      glyphFx(o, rec, effects, (g) => g.el);
    }

    // 2c) copias visuales de la ecuación origen («Mantener ecuación origen»)
    const liveGhosts = new Set<string>();
    for (const o of p.objects) {
      const rec = this.objs.get(o.id);
      const objFx = ghostStates.get(o.id);
      const glyphFxMap = ghostGlyphs.get(o.id);
      if (!rec || (!objFx && !glyphFxMap)) continue;
      const ghost = this.ghostOf(rec, o);
      liveGhosts.add(o.id);
      if (ghost.wrapper.previousElementSibling !== rec.wrapper) rec.wrapper.after(ghost.wrapper);
      ghost.wrapper.style.width = rec.wrapper.style.width;
      ghost.wrapper.style.height = rec.wrapper.style.height;
      const rootFill = p.styles[o.id]?.fill;
      if (rootFill !== undefined) for (const el of Array.from(ghost.svg.querySelectorAll(PAINT_SEL))) P(el).fill = rootFill;
      if (glyphFxMap || o.glyphStyles) {
        glyphFx(o, rec, glyphFxMap, (g) => ghost.svg.querySelector(`[data-mm-glyph="${g.index}"]`));
      }
      const st = states.get(o.id);
      const css =
        `translate(${(o.x - o.bw / 2 + (st?.dx ?? 0) + (objFx?.dx ?? 0)).toFixed(3)}px,${(o.y - o.bh / 2 + (st?.dy ?? 0) + (objFx?.dy ?? 0)).toFixed(3)}px) ` +
        `rotate(${(o.rotation + (st?.rot ?? 0) + (objFx?.rot ?? 0)).toFixed(3)}deg) ` +
        `scale(${(o.scale * (st?.scale ?? 1) * (objFx?.scale ?? 1)).toFixed(5)})`;
      ghost.wrapper.style.transform = css;
      ghost.wrapper.style.opacity = String((st?.opacity ?? 1) * (p.styles[o.id]?.opacity ?? 1) * (objFx?.opacity ?? 1));
    }
    for (const [id, ghost] of this.ghosts) if (!liveGhosts.has(id)) ghost.wrapper.remove();

    // 3) contenedores raíz (posición, escala, rotación, opacidad, resplandor)
    for (const o of p.objects) {
      const rec = this.objs.get(o.id);
      if (!rec) continue;
      const st = states.get(o.id);
      const dx = st?.dx ?? 0;
      const dy = st?.dy ?? 0;
      const css =
        `translate(${(o.x - o.bw / 2 + dx).toFixed(3)}px,${(o.y - o.bh / 2 + dy).toFixed(3)}px) ` +
        `rotate(${(o.rotation + (st?.rot ?? 0)).toFixed(3)}deg) scale(${(o.scale * (st?.scale ?? 1)).toFixed(5)})`;
      const op = String((st?.opacity ?? 1) * (p.styles[o.id]?.opacity ?? 1));
      const filter = st && st.glow > 0
        ? `drop-shadow(0 0 ${(8 + 34 * st.glow).toFixed(1)}px ${st.glowColor}) brightness(${(1 + 0.2 * st.glow).toFixed(3)})`
        : '';
      const inert = hiddenIds.has(o.id);
      const sig = `${css}|${op}|${filter}|${inert}`;
      if (sig !== rec.lastCss) {
        rec.lastCss = sig;
        rec.wrapper.style.transform = css;
        rec.wrapper.style.opacity = op;
        rec.wrapper.style.pointerEvents = inert ? 'none' : '';
        rec.wrapper.style.filter = filter;
      }
    }

    // 4) Escribir / Dibujar
    for (const [id, st] of states) {
      if (st.draw === null || st.draw >= 1) continue;
      const n = this.nodes.get(id);
      if (!n) continue;
      // Las gráficas y puntos con clip de entrada propio no siguen el `Create` del plano base.
      const owned = n.isRoot ? this.ownedSubs.get(id) : undefined;
      const geoms = this.geomsOf(n).filter((el) => {
        const sub = owned && el.closest('[data-mm-sub]')?.getAttribute('data-mm-sub');
        return !(sub && owned!.has(sub));
      });
      if (!geoms.length) continue;
      if (n.isRoot) this.objs.get(id)?.svg.querySelectorAll('[data-mm-tip]').forEach((tip) => mul(tip, 'fill-opacity', clamp01((st.draw! - 0.8) / 0.2), 1));
      const glyphCount = n.isRoot ? this.objs.get(id)?.glyphs.length ?? 0 : 0;
      const count = glyphCount || geoms.length;
      const lag = st.lag;
      const win = count > 1 ? (lag !== null ? 0.8 / (1 + (count - 1) * lag) : 0.5) : 0.8;
      const stagger = count > 1 ? (lag !== null ? lag * win : (0.8 - win) / (count - 1)) : 0;
      // Plano cartesiano: `Create(plane)` revela la cuadrícula, los ejes con sus marcas, los números, las gráficas y los puntos.
      const planeCounts: Record<string, number> = {};
      const planeSlots = n.isRoot && this.project?.objects.some((o) => o.id === id && o.plane)
        ? geoms.map((el) => {
            const phase = el.closest('[data-mm-phase]')?.getAttribute('data-mm-phase') ?? 'grid';
            planeCounts[phase] = (planeCounts[phase] ?? 0) + 1;
            return { phase, index: planeCounts[phase] - 1 };
          })
        : null;
      geoms.forEach((el, k) => {
        // En fórmulas el escalonado es por glifo (como los submobjects de MathTex).
        const i = glyphCount ? Number(el.closest('[data-mm-glyph]')?.getAttribute('data-mm-glyph') ?? k) : k;
        const info = this.geomInfo(el);
        let ps = clamp01((st.draw! - i * stagger) / win);
        if (planeSlots) {
          const { phase, index } = planeSlots[k];
          const [from, to] = PLANE_PHASES[phase] ?? PLANE_PHASES.grid;
          const lag = 0.12;
          const slice = 1 / (1 + (planeCounts[phase] - 1) * lag);
          ps = clamp01((clamp01((st.draw! - from) / (to - from)) - index * lag * slice) / slice);
        }
        const pf = clamp01((st.draw! - 0.8) / 0.2);
        const pr = P(el);
        if (info.isText) {
          mul(el, 'opacity', ps, this.baseOpacity(el));
          return;
        }
        if (info.dashLen <= 0) return;
        const fill = pr.fill ?? info.fill;
        const stroke = pr.stroke ?? info.stroke;
        const sw = pr['stroke-width'] !== undefined ? parseFloat(pr['stroke-width']) : info.sw;
        const hasFill = fill !== 'none';
        const hasStroke = stroke !== 'none' && sw > 0;
        if (hasStroke) {
          pr['stroke-dasharray'] = String(info.dashLen);
          pr['stroke-dashoffset'] = String(info.dashLen * (1 - ps));
          if (ps <= 0) pr['stroke-opacity'] = '0';
          if (hasFill) mul(el, 'fill-opacity', pf, info.fillOpacity);
        } else if (hasFill) {
          // Figura rellena sin trazo: se dibuja su contorno y el relleno aparece al final.
          pr.stroke = fill;
          pr['stroke-width'] = String(info.cw);
          pr['stroke-dasharray'] = String(info.dashLen);
          pr['stroke-dashoffset'] = String(info.dashLen * (1 - ps));
          pr['stroke-opacity'] = ps <= 0 ? '0' : String(1 - pf);
          mul(el, 'fill-opacity', pf, info.fillOpacity);
        }
      });
    }

    this.commit(next);

    // 4b) Deformación de la figura principal de las transformaciones de grupo en curso
    this.syncMorphs(morphs);

    // 5) Radar (capa de efectos del escenario)
    this.drawRings(rings, frames);

  }

  /** Copia limpia del objeto origen, fija en su sitio; la animación solo mueve esta copia. */
  private ghostOf(rec: ObjRec, o: Obj2D) {
    let g = this.ghosts.get(o.id);
    if (g && g.src !== rec) {
      g.wrapper.remove();
      this.ghosts.delete(o.id);
      g = undefined;
    }
    if (!g) {
      const doc = new DOMParser().parseFromString(o.markup, 'image/svg+xml');
      const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
      svg.querySelectorAll('[data-mm-id]').forEach((el) => el.removeAttribute('data-mm-id'));
      if (o.kind === 'formula' && !o.vector) findGlyphElements(svg).forEach((el, index) => el.setAttribute('data-mm-glyph', String(index)));
      const wrapper = document.createElement('div');
      wrapper.className = 'mm-obj';
      wrapper.dataset.kind = o.kind;
      wrapper.style.pointerEvents = 'none';
      wrapper.appendChild(svg);
      g = { src: rec, wrapper, svg };
      this.ghosts.set(o.id, g);
    }
    return g;
  }

  private commit(next: Map<Element, Props>) {
    for (const [el, old] of this.applied) {
      const cur = next.get(el);
      if (!cur) {
        for (const k of Object.keys(old)) this.restoreProp(el, k);
      } else {
        for (const k of Object.keys(old)) if (!(k in cur)) this.restoreProp(el, k);
      }
    }
    for (const [el, props] of next) {
      const keys = Object.keys(props);
      if (!keys.length) continue;
      const old = this.applied.get(el);
      const st = (el as HTMLElement).style;
      let orig = this.origInline.get(el);
      for (const k of keys) {
        if (old && old[k] === props[k]) continue;
        if (!orig) this.origInline.set(el, (orig = new Map()));
        if (!orig.has(k)) orig.set(k, st.getPropertyValue(k));
        st.setProperty(k, props[k]);
      }
    }
    for (const [el, props] of Array.from(next)) if (!Object.keys(props).length) next.delete(el);
    this.applied = next;
  }

  /** Grupo SVG (nodo) de un sub-elemento de plano, o `null` si ya no existe o no se dibuja. */
  private subNodeId(objId: string, sub: string): string | null {
    const id = this.objs.get(objId)?.svg.querySelector(`[data-mm-sub="${sub}"]`)?.getAttribute('data-mm-id');
    return id && this.nodes.has(id) ? id : null;
  }

  /**
   * Los clips con `parameters.subElementId` (`plot:<id>` / `point:<id>`) se redirigen al grupo SVG de ese
   * elemento y se animan como un nodo hijo. `Create` sobre un punto equivale a «brotar». Los clips cuyo
   * elemento ya no existe se omiten. Un elemento con clip de entrada (`draw`/`appear`) queda oculto hasta su inicio.
   */
  private resolveSubClips(clips: Clip[]): Clip[] {
    this.ownedSubs = new Map();
    if (!clips.some((c) => c.parameters.subElementId !== undefined)) return clips;
    const out: Clip[] = [];
    for (const clip of clips) {
      const sub = planeSubElementOf(clip);
      if (!sub) {
        if (clip.parameters.subElementId === undefined) out.push(clip);
        continue;
      }
      const key = `${sub.kind}:${sub.id}`;
      const nodeId = this.subNodeId(clip.targetId, key);
      if (!nodeId) continue;
      if (clip.type === 'draw' || clip.type === 'appear') {
        const set = this.ownedSubs.get(clip.targetId) ?? new Set<string>();
        set.add(key);
        this.ownedSubs.set(clip.targetId, set);
      }
      const pop = sub.kind === 'point' && clip.type === 'draw';
      out.push({ ...clip, targetId: nodeId, type: pop ? 'appear' : clip.type, parameters: pop ? { ...clip.parameters, mode: 'pop' } : clip.parameters });
    }
    return out;
  }

  private computeStates(clips: Clip[], t: number) {
    const states = new Map<string, NState>();
    const rings: Ring[] = [];
    const frames: Frame[] = [];
    const glyphStates = new Map<string, Map<number, GState>>();
    /** Estados de las copias visuales (clips con «Mantener ecuación origen»). */
    const ghostStates = new Map<string, NState>();
    const ghostGlyphs = new Map<string, Map<number, GState>>();
    const hiddenIds = new Set<string>();
    const morphs: Morph[] = [];
    const glyphState = (objId: string, index: number, ghost = false): GState => {
      const store = ghost ? ghostGlyphs : glyphStates;
      let list = store.get(objId);
      if (!list) store.set(objId, (list = new Map()));
      let g = list.get(index);
      if (!g) list.set(index, (g = { opacity: 1, dx: 0, dy: 0, sc: 1, rot: 0, mix: [], strokeMix: [], strokeWidthTo: [], glow: 0, glowColor: '#fde047' }));
      return g;
    };
    const glyphsOf = (o: Obj2D) => this.objs.get(o.id)!.glyphs.map((g) => g.index);
    /** Escala, gira y desplaza un grupo de glifos alrededor de su propio centro. */
    const moveGroup = (o: Obj2D, geo: GlyphGeo[], idx: number[], k: number, rotDeg: number, tw: { x: number; y: number }, ghost = false) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const i of idx) {
        const b = geo[i].box;
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
      }
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const th = (rotDeg * Math.PI) / 180;
      for (const i of idx) {
        const rx = geo[i].center.x - cx;
        const ry = geo[i].center.y - cy;
        const g = glyphState(o.id, i, ghost);
        g.dx += k * (rx * Math.cos(th) - ry * Math.sin(th)) - rx + tw.x;
        g.dy += k * (rx * Math.sin(th) + ry * Math.cos(th)) - ry + tw.y;
        g.sc *= k;
        g.rot += rotDeg;
      }
    };
    const get = (id: string, ghost = false): NState => {
      const store = ghost ? ghostStates : states;
      let s = store.get(id);
      if (!s) {
        s = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0, glow: 0, glowColor: '#fde047', draw: null, lag: null, fillMix: [], strokeMix: [], fillOpacityTo: [], strokeWidthTo: [] };
        store.set(id, s);
      }
      return s;
    };
    const sorted = clips.slice().sort((a, b) => a.start - b.start);
    // Transformaciones dirigidas glifo → glifo: cada glifo destino se oculta hasta que llega el suyo.
    const directed = directedGlyphClips(sorted);
    const directedOf = new Map<Clip, DirectedGlyphClip>(directed.map((d) => [d.clip, d]));
    const targeted = directedTargets(directed);
    // Salidas (`disappear`) y re-entradas: una salida deja oculto su alcance hasta que empieza un clip de entrada
    // posterior sobre el mismo objeto (y glifos); ese clip de entrada no oculta nada antes de su inicio.
    const scopeOf = (c: Clip): number[] | null => {
      const fo = this.formulaOf(c.targetId);
      return fo ? clipGlyphs(fo, c.parameters) : null;
    };
    const overlaps = (a: number[] | null, b: number[] | null) => !a || !b || a.some((i) => b.includes(i));
    const exits = sorted.filter((c) => c.type === 'disappear');
    const reentries = new Map<Clip, { start: number; scope: number[] | null }[]>();
    const afterExit = new Set<Clip>();
    for (const d of exits) {
      const scope = scopeOf(d);
      const list: { start: number; scope: number[] | null }[] = [];
      for (const e of sorted) {
        if (!isEntranceClip(e) || e.targetId !== d.targetId || e.start <= d.start + 1e-9) continue;
        const scopeE = scopeOf(e);
        if (!overlaps(scope, scopeE)) continue;
        list.push({ start: e.start, scope: scopeE });
        afterExit.add(e);
      }
      reentries.set(d, list);
    }
    /** ¿Algún clip de entrada posterior a la salida `d` ya empezó en `t` (para el glifo `glyph`, o el objeto)? */
    const reentered = (d: Clip, glyph: number | null) =>
      (reentries.get(d) ?? []).some((e) => t >= e.start && (glyph === null || !e.scope || e.scope.includes(glyph)));
    /** Glifos de la copia visual del origen que viajan en este instante (el resto de la copia se oculta). */
    const ghostMoving = new Map<string, Set<number>>();
    // Destinos de transformaciones sin entrada propia anterior: ocultos hasta que empieza la transformación.
    const revealAt = new Map<string, number>();
    for (const c of sorted) {
      if (c.type !== 'transform' && c.type !== 'transformMatch') continue;
      if (directedOf.has(c)) continue;
      const to = c.parameters.to;
      if (typeof to !== 'string' || to === c.targetId || revealAt.has(to)) continue;
      const entrance = sorted.some((k) => k.targetId === to && (k.type === 'draw' || k.type === 'appear') && k.start < c.start);
      if (!entrance) revealAt.set(to, c.start);
    }
    // Transformación de grupo: cada objeto del grupo destino sin animación previa permanece oculto hasta el inicio.
    for (const c of sorted) {
      const group = groupTransformOf(c);
      if (!group) continue;
      for (const id of group.targetObjectIds) {
        if (revealAt.has(id)) continue;
        const earlier = sorted.some((k) => k !== c && k.start < c.start && (
          k.targetId === id || k.parameters.to === id || (groupTransformOf(k)?.targetObjectIds.includes(id) ?? false)));
        if (!earlier) revealAt.set(id, c.start);
      }
    }
    for (const [id, start] of revealAt) {
      if (t >= start || !this.nodes.has(id)) continue;
      get(id).opacity *= 0;
      hiddenIds.add(id);
    }
    for (const [objId, set] of targeted) {
      const fo = this.formulaOf(objId);
      const rec = fo && this.objs.get(objId);
      if (!fo || !rec) continue;
      const arrive = new Map<number, number>();
      for (const d of directed) {
        if (d.spec.targetObjectId !== objId) continue;
        const end = d.clip.start + d.clip.duration;
        for (const j of d.dst) arrive.set(j, Math.min(arrive.get(j) ?? Infinity, end));
      }
      const plan = connectorPlan(directed, objId, rec.glyphs.map((g) => g.char), set);
      const geoT = plan.size ? this.geoOf(rec) : null;
      for (const g of rec.glyphs) {
        const end = arrive.get(g.index);
        if (end !== undefined) {
          if (t < end) glyphState(objId, g.index).opacity *= 0;
          continue;
        }
        // Glifos que no vienen de otro objeto (+, paréntesis…): permanecen ocultos hasta su propio clip de
        // entrada (Write, FadeIn o Brotar); no aparecen solos al terminar los clips dirigidos.
        const own = sorted.some((k) => (k.type === 'draw' || k.type === 'appear') && k.targetId === objId
          && entranceScope(fo, k.parameters, set, rec.glyphs.length)?.includes(g.index));
        const via = own ? undefined : plan.get(g.index);
        if (via) {
          // Conector (·, +, =…): brota desde su centro (0.4 → 1) durante el último 40 % del clip que cierra a sus vecinos.
          const q = clamp01((t - (via.clip.start + 0.6 * via.clip.duration)) / (0.4 * via.clip.duration));
          const e = smooth(q);
          glyphState(objId, g.index).opacity *= e;
          if (geoT && g.index < geoT.length && e < 1) moveGroup(fo, geoT, [g.index], 0.4 + 0.6 * e, 0, { x: 0, y: 0 });
          continue;
        }
        if (!own) glyphState(objId, g.index).opacity *= 0;
      }
    }
    for (const c of sorted) {
      if (!this.nodes.has(c.targetId)) continue;
      const raw = (t - c.start) / c.duration;
      const p = clamp01(raw);
      const live = raw >= 0 && raw <= 1;
      const par = c.parameters;
      // Re-entrada tras una salida: antes de su inicio, la salida previa ya mantiene oculto el alcance.
      if (raw < 0 && afterExit.has(c)) continue;
      switch (c.type) {
        case 'draw': {
          const fo = this.formulaOf(c.targetId);
          const scope = fo ? entranceScope(fo, par, targeted.get(fo.id), this.objs.get(fo.id)!.glyphs.length) : null;
          if (fo && scope) {
            // Write sobre glifos concretos: solo ellos aparecen; los que ya llegaron no se tocan.
            for (const i of scope) glyphState(fo.id, i).opacity *= easeOut(p);
            break;
          }
          const s = get(c.targetId);
          s.draw = p;
          s.lag = typeof par.lagRatio === 'number' && par.lagRatio >= 0 ? par.lagRatio : null;
          break;
        }
        case 'appear': {
          const fo = this.formulaOf(c.targetId);
          const scope = fo ? entranceScope(fo, par, targeted.get(fo.id), this.objs.get(fo.id)!.glyphs.length) : null;
          if (fo && scope && par.mode === 'pop') {
            // Brotar (GrowFromCenter): escala 0 → 1.2 → 1 desde su centro, con opacidad 0 → 1 (`smooth`).
            const rec = this.objs.get(fo.id);
            const geo = rec ? this.geoOf(rec) : null;
            const idx = scope.filter((i) => !geo || i < geo.length);
            const grow = p < 0.7 ? 1.2 * smooth(p / 0.7) : 1.2 - 0.2 * smooth((p - 0.7) / 0.3);
            if (geo && idx.length) moveGroup(fo, geo, idx, Math.max(0.001, grow), 0, { x: 0, y: 0 });
            for (const i of scope) glyphState(fo.id, i).opacity *= smooth(p);
            break;
          }
          if (fo && scope) {
            const eg = easeOut(p);
            const dirG = str(par.direction, 'up');
            const shift = this.stageVec(fo,
              (dirG === 'left' ? -1 : dirG === 'right' ? 1 : 0) * (1 - eg) * num(par.distance, 120),
              (dirG === 'up' ? -1 : dirG === 'down' ? 1 : 0) * (1 - eg) * num(par.distance, 120));
            for (const i of scope) {
              const g = glyphState(fo.id, i);
              g.opacity *= eg;
              g.dx += shift.x;
              g.dy += shift.y;
            }
            break;
          }
          if (par.mode === 'pop') {
            // Brotar (GrowFromCenter) de un objeto completo, un nodo o un punto de un plano (con su etiqueta y líneas
            // guía): escala 0 → 1.2 → 1 desde su centro y opacidad 0 → 1 (`smooth`).
            const sub = get(c.targetId);
            sub.scale *= Math.max(0.001, p < 0.7 ? 1.2 * smooth(p / 0.7) : 1.2 - 0.2 * smooth((p - 0.7) / 0.3));
            sub.opacity *= smooth(p);
            break;
          }
          const s = get(c.targetId);
          const e = easeOut(p);
          s.opacity *= e;
          const d = num(par.distance, 120);
          const dir = str(par.direction, 'up');
          // La dirección indica de dónde llega el objeto.
          const vx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
          const vy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
          s.dx += vx * (1 - e) * d;
          s.dy += vy * (1 - e) * d;
          break;
        }
        case 'glow':
          if (live) {
            const s = get(c.targetId);
            const b = Math.sin(Math.PI * p);
            if (b > s.glow) {
              s.glow = b;
              s.glowColor = str(par.color, '#fde047');
            }
            s.scale *= 1 + 0.12 * b;
          }
          break;
        case 'rotate': {
          const s = get(c.targetId);
          const spin = str(par.mode, 'angle') === 'spin';
          const total = spin ? num(par.speed, 90) * c.duration : num(par.angle, 360);
          const r = total * (spin ? p : easeInOut(p));
          s.rot += r;
          break;
        }
        case 'radar':
          if (live) rings.push({ targetId: c.targetId, p, color: str(par.color, '#38bdf8'), max: typeof par.size === 'number' ? par.size : null });
          break;
        case 'indicate': {
          if (!live) break;
          const b = easeInOut(p < 0.5 ? 2 * p : 2 - 2 * p);
          if (b <= 0) break;
          const factor = num(par.scale, 1.3);
          const color = str(par.color, '#ffff00');
          // Relleno y contorno independientes: sin relleno, el color original del glifo/objeto queda intacto; con
          // contorno, crece hacia fuera (`paint-order: stroke fill`) y vuelve a su estado original con el pulso.
          const ind = indicateSpecOf(par);
          const glowColor = ind.useFill || !ind.strokeColor ? color : ind.strokeColor;
          const fo = this.formulaOf(c.targetId);
          const rec = fo && this.objs.get(fo.id);
          const geo = rec ? this.geoOf(rec) : null;
          if (fo && geo) {
            const idx = (clipGlyphs(fo, par) ?? glyphsOf(fo)).filter((i) => i < geo.length);
            moveGroup(fo, geo, idx, 1 + (factor - 1) * b, 0, { x: 0, y: 0 });
            for (const i of idx) {
              const g = glyphState(fo.id, i);
              if (ind.useFill) g.mix.push([color, b]);
              if (ind.strokeColor) {
                g.strokeMix.push([ind.strokeColor, b, true]);
                g.strokeWidthTo.push([ind.strokeWidth, b]);
              }
              if (b > g.glow) {
                g.glow = b;
                g.glowColor = glowColor;
              }
            }
          } else {
            const s = get(c.targetId);
            s.scale *= 1 + (factor - 1) * b;
            if (b > s.glow) {
              s.glow = b;
              s.glowColor = glowColor;
            }
            // Pulso de color en relleno y trazo (y puntas de flecha); vuelve al color original al terminar.
            if (ind.useFill) s.fillMix.push([color, b]);
            if (ind.strokeColor) {
              s.strokeMix.push([ind.strokeColor, b, true]);
              s.strokeWidthTo.push([ind.strokeWidth, b]);
            } else if (ind.useFill) {
              s.strokeMix.push([color, b, false]);
            }
          }
          break;
        }
        case 'colorChange': {
          // Permanente: interpola con curva suave en [start, end] y se mantiene después.
          // Con `revertOnEnd`: 0–25 % entra al color nuevo, 25–75 % lo mantiene, 75–100 % vuelve al color previo
          // (y desde `end` el estado anterior queda restaurado: la mezcla vale 0).
          if (raw < 0) break;
          const e = par.revertOnEnd === true
            ? (raw >= 1 ? 0 : p < 0.25 ? smooth(p / 0.25) : p <= 0.75 ? 1 : smooth((1 - p) / 0.25))
            : smooth(p);
          if (e <= 0) break;
          const fill = par.fillEnabled === false ? null : typeof par.targetFillColor === 'string' ? par.targetFillColor : null;
          const stroke = par.strokeEnabled === false ? null : typeof par.targetStrokeColor === 'string' ? par.targetStrokeColor : null;
          const fillOpacity = par.fillEnabled !== false && typeof par.targetFillOpacity === 'number' ? clamp01(par.targetFillOpacity) : null;
          const width = typeof par.targetStrokeWidth === 'number' ? Math.min(20, Math.max(0, par.targetStrokeWidth)) : null;
          const fo = this.formulaOf(c.targetId);
          if (fo) {
            // Ecuaciones: el relleno tiñe los glifos; el trazo les añade un contorno exterior (2 px por defecto).
            const count = this.objs.get(fo.id)?.glyphs.length ?? 0;
            for (const i of (clipGlyphs(fo, par) ?? glyphsOf(fo)).filter((i) => i >= 0 && i < count)) {
              const g = glyphState(fo.id, i);
              if (fill) g.mix.push([fill, e]);
              if (stroke) {
                g.strokeMix.push([stroke, e, true]);
                g.strokeWidthTo.push([width ?? 2, e]);
              }
            }
            break;
          }
          const s = get(c.targetId);
          if (fill) s.fillMix.push([fill, e]);
          if (stroke) {
            s.strokeMix.push([stroke, e, true]);
            if (width !== null) s.strokeWidthTo.push([width, e]);
          }
          if (fillOpacity !== null) s.fillOpacityTo.push([fillOpacity, e]);
          break;
        }
        case 'disappear': {
          // Desvanecer (FadeOut) o Contraer (ShrinkToCenter): nada antes del inicio; `smooth` durante el clip y, desde
          // el final, oculto hasta que un clip de entrada posterior lo vuelva a mostrar.
          if (raw < 0) break;
          const e = smooth(p);
          const shrink = disappearModeOf(par) === 'shrink';
          const fo = this.formulaOf(c.targetId);
          if (fo) {
            // Ecuaciones: por glifo (toda la ecuación o el alcance elegido); contrae hacia el centro del conjunto.
            const rec = this.objs.get(fo.id)!;
            const explicit = clipGlyphs(fo, par);
            const idx = (explicit ?? glyphsOf(fo)).filter((i) => i >= 0 && i < rec.glyphs.length && !reentered(c, i));
            if (!idx.length) break;
            const geo = shrink ? this.geoOf(rec) : null;
            if (geo) moveGroup(fo, geo, idx.filter((i) => i < geo.length), Math.max(1e-3, 1 - e), 0, { x: 0, y: 0 });
            for (const i of idx) glyphState(fo.id, i).opacity *= 1 - e;
            if (raw >= 1 && !explicit && idx.length === rec.glyphs.length) hiddenIds.add(fo.id);
            break;
          }
          if (reentered(c, null)) break;
          const s = get(c.targetId);
          s.opacity *= 1 - e;
          if (shrink) s.scale *= Math.max(1e-3, 1 - e);
          // Ya fuera de escena: el objeto no intercepta clics en el lienzo.
          if (raw >= 1 && this.nodes.get(c.targetId)?.isRoot) hiddenIds.add(c.targetId);
          break;
        }
        case 'circumscribe':
        case 'focus': {
          const spot = c.type === 'focus' ? focusSpecOf(c) : null;
          if (spot) {
            // Enfoque / Spotlight: 0–20 % el resto de la escena baja a `dimOpacity` y los objetivos pasan al frente
            // (color de enfoque, resplandor `drop-shadow` sutil y realce de escala); 20–80 % se mantiene; 80–100 %
            // todo regresa (`smooth`). Antes del inicio y desde `end` no toca nada. Lo dibuja igual la exportación MP4.
            const e = focusEnvelope(raw);
            if (e <= 0) break;
            const dim = 1 - (1 - spot.dimOpacity) * e;
            const lift = 1 + (spot.pulseScale - 1) * e;
            const color = spot.useHighlightColor ? spot.highlightColor : null;
            // Contorno exterior independiente del relleno (px del escenario → unidades locales en applyStroke).
            const outline = spot.useStrokeColor ? spot.highlightStrokeColor : null;
            const outlineWidth = spot.highlightStrokeWidth ?? 2;
            const glowColor = withAlpha(color ?? outline ?? '#ffffff', 0.9 * e);
            const glow = 0.45 * e;
            const byId = new Map(spot.targets.map((entry) => [entry.objectId, entry]));
            for (const o of this.project!.objects) {
              if (!this.nodes.has(o.id)) continue;
              const target = byId.get(o.id);
              const fo = target ? this.formulaOf(o.id) : undefined;
              const rec = fo && this.objs.get(fo.id);
              const geo = rec && rec.glyphs.length ? this.geoOf(rec) : null;
              if (target && fo && rec && geo) {
                // Ecuación: glifos enfocados (o toda la ecuación) brillan; el resto de sus glifos se atenúa.
                const focused = new Set((target.glyphIndices ?? glyphsOf(fo)).filter((i) => i < rec.glyphs.length));
                for (const g of rec.glyphs) if (!focused.has(g.index)) glyphState(fo.id, g.index).opacity *= dim;
                // Cada tramo contiguo (p. ej. x₁) crece alrededor de su propio centro: no se separan entre sí.
                for (const [a, b] of glyphRuns([...focused])) {
                  const run = Array.from({ length: b - a + 1 }, (_, k) => a + k).filter((i) => i < geo.length);
                  if (run.length && lift !== 1) moveGroup(fo, geo, run, lift, 0, { x: 0, y: 0 });
                }
                for (const i of focused) {
                  const g = glyphState(fo.id, i);
                  if (color) g.mix.push([color, e]);
                  if (outline) {
                    g.strokeMix.push([outline, e, true]);
                    g.strokeWidthTo.push([outlineWidth, e]);
                  }
                  if (glow > g.glow) {
                    g.glow = glow;
                    g.glowColor = glowColor;
                  }
                }
                continue;
              }
              const s = get(o.id);
              if (!target) {
                s.opacity *= dim;
                continue;
              }
              // Objeto completo (figura, trazado, texto, plano…): realce de escala, color y resplandor.
              s.scale *= lift;
              if (color) s.fillMix.push([color, e]);
              if (outline) {
                s.strokeMix.push([outline, e, true]);
                s.strokeWidthTo.push([outlineWidth, e]);
              } else if (color) {
                s.strokeMix.push([color, e, false]);
              }
              if (glow > s.glow) {
                s.glow = glow;
                s.glowColor = glowColor;
              }
            }
            break;
          }
          if (!live) break;
          const fo = this.formulaOf(c.targetId);
          frames.push({
            kind: c.type, targetId: c.targetId, glyphs: fo ? clipGlyphs(fo, par) : null, p,
            color: str(par.color, c.type === 'focus' ? '#888888' : '#ffff00'), opacity: num(par.opacity, 0.2),
          });
          break;
        }
        case 'transform': {
          const dg = directedOf.get(c);
          if (dg) {
            // Glifo → glifo: sourceGlyphIds[i] viaja (copia o movimiento) hasta targetGlyphIds[i] con `smooth`.
            const GA = this.formulaOf(dg.spec.sourceObjectId);
            const GB = this.formulaOf(dg.spec.targetObjectId);
            const rA = GA && this.objs.get(GA.id);
            const rB = GB && this.objs.get(GB.id);
            const gA = rA ? this.geoOf(rA) : null;
            const gB = rB ? this.geoOf(rB) : null;
            if (!GA || !GB || !rA || !rB || !gA || !gB || raw < 0) break;
            const keepSrc = dg.spec.keepSource;
            if (raw >= 1) {
              // El glifo destino ya está visible; sin copia, el origen se consume.
              if (!keepSrc) for (const i of dg.src) glyphState(GA.id, i).opacity *= 0;
              break;
            }
            const sm = smooth(p);
            const colA = this.baseColor(rA, this.project!.styles[GA.id]?.fill);
            const colB = this.baseColor(rB, this.project!.styles[GB.id]?.fill);
            const moving = ghostMoving.get(GA.id) ?? new Set<number>();
            dg.src.forEach((ai, n) => {
              const bj = dg.dst[n];
              if (ai >= gA.length || bj >= gB.length) return;
              const sa = this.stageBounds(GA, gA, [ai]);
              const sb = this.stageBounds(GB, gB, [bj]);
              const ratio = Math.sqrt((sb.w * sb.h) / Math.max(1e-6, sa.w * sa.h));
              const k = 1 + ((Number.isFinite(ratio) && ratio > 0 ? ratio : 1) - 1) * sm;
              moveGroup(GA, gA, [ai], k, 0, this.stageVec(GA, (sb.cx - sa.cx) * sm, (sb.cy - sa.cy) * sm), keepSrc);
              const from = GA.glyphStyles?.[ai]?.color ?? colA;
              const to = GB.glyphStyles?.[bj]?.color ?? colB;
              if (from !== to && sm > 0) glyphState(GA.id, ai, keepSrc).mix.push([to, sm]);
              moving.add(ai);
            });
            if (keepSrc) ghostMoving.set(GA.id, moving);
            break;
          }
          const e = easeInOut(p);
          const A = this.obj2d(c.targetId);
          const B = typeof par.to === 'string' && par.to !== c.targetId ? this.obj2d(par.to) : undefined;
          const fa = A && this.formulaOf(A.id);
          const recA = fa ? this.objs.get(fa.id) : undefined;
          const geoA = recA ? this.geoOf(recA) : null;
          const srcIdx = fa ? clipGlyphs(fa, par) : null;
          if (A && B) {
            // «Mantener ecuación origen»: A queda fija y solo se anima una copia visual.
            const keep = par.keep === true;
            const ghostOn = !keep || live;
            const fb = this.formulaOf(B.id);
            const recB = fb ? this.objs.get(fb.id) : undefined;
            const geoB = recB ? this.geoOf(recB) : null;
            const dst = typeof par.toTerm === 'string' ? fb?.terms?.find((term) => term.id === par.toTerm) : undefined;
            if (fa && fb && geoA && geoB && (srcIdx || dst)) {
              // Sub-término → sub-término: el origen viaja al destino mientras este aparece.
              const aIdx = (srcIdx ?? glyphsOf(fa)).filter((i) => i < geoA.length);
              const bIdx = (dst?.glyphs ?? glyphsOf(fb)).filter((i) => i < geoB.length);
              if (aIdx.length && bIdx.length) {
                const sa = this.stageBounds(fa, geoA, aIdx);
                const sb = this.stageBounds(fb, geoB, bIdx);
                const ratio = Math.sqrt((sb.w * sb.h) / Math.max(1e-6, sa.w * sa.h));
                const k = 1 + ((Number.isFinite(ratio) && ratio > 0 ? ratio : 1) - 1) * e;
                if (ghostOn) {
                  moveGroup(fa, geoA, aIdx, k, 0, this.stageVec(fa, (sb.cx - sa.cx) * e, (sb.cy - sa.cy) * e), keep);
                  for (const i of aIdx) glyphState(fa.id, i, keep).opacity *= 1 - e;
                  if (keep) for (const i of glyphsOf(fa)) if (!aIdx.includes(i)) glyphState(fa.id, i, true).opacity = 0;
                }
                for (const i of bIdx) glyphState(fb.id, i).opacity *= raw < 0 ? 0 : e;
                // El resto de B aparece junto con la transformación si B estaba oculto.
                if (revealAt.has(fb.id)) for (const i of glyphsOf(fb)) if (!bIdx.includes(i)) glyphState(fb.id, i).opacity *= raw < 0 ? 0 : e;
              }
            } else {
              // Objeto completo: posición, escala, rotación y opacidad hacia la pose de B.
              if (ghostOn) {
                const s = get(A.id, keep);
                s.dx += (B.x - A.x) * e;
                s.dy += (B.y - A.y) * e;
                s.rot += (B.rotation - A.rotation) * e;
                s.scale *= 1 + (B.scale / A.scale - 1) * e;
                s.opacity *= 1 - e;
              }
              get(B.id).opacity *= raw < 0 ? 0 : e;
            }
            break;
          }
          // Sin objeto destino: se interpola hacia el estado indicado por los parámetros.
          const dx = num(par.dx, 0);
          const dy = num(par.dy, 0);
          const factor = num(par.scale, 1);
          const rot = num(par.rotation, 0);
          const opacity = num(par.opacity, 1);
          const color = typeof par.color === 'string' && par.color ? par.color : null;
          if (fa && geoA) {
            const idx = (srcIdx ?? glyphsOf(fa)).filter((i) => i < geoA.length);
            moveGroup(fa, geoA, idx, 1 + (factor - 1) * e, rot * e, this.stageVec(fa, dx * e, dy * e));
            for (const i of idx) {
              const g = glyphState(fa.id, i);
              g.opacity *= 1 + (opacity - 1) * e;
              if (color && e > 0) g.mix.push([color, e]);
            }
          } else {
            const s = get(c.targetId);
            s.dx += dx * e;
            s.dy += dy * e;
            s.rot += rot * e;
            s.scale *= 1 + (factor - 1) * e;
            s.opacity *= 1 + (opacity - 1) * e;
          }
          break;
        }
        case 'groupTransform': {
          const group = groupTransformOf(c);
          if (group) this.applyGroupTransform(c, group, raw, get, morphs, hiddenIds);
          break;
        }
        case 'transformMatch': {
          const A = this.formulaOf(c.targetId);
          const B = typeof par.to === 'string' && par.to !== c.targetId ? this.formulaOf(par.to) : undefined;
          const recA = A && this.objs.get(A.id);
          const recB = B && this.objs.get(B.id);
          const geoA = recA ? this.geoOf(recA) : null;
          const geoB = recB ? this.geoOf(recB) : null;
          if (!A || !B || !recA || !recB || !geoA || !geoB) break;
          if (raw < 0) {
            get(B.id).opacity *= 0;
            break;
          }
          const keep = par.keep === true;
          if (raw >= 1) {
            if (!keep) get(A.id).opacity *= 0;
            break;
          }
          const e = smooth(p);
          const key = `${A.id}|${B.id}|${recA.markup.length}|${recB.markup.length}`;
          let pairs = this.matches.get(key);
          if (!pairs) {
            pairs = matchGlyphs(recA.glyphs.map((g) => g.key), recB.glyphs.map((g) => g.key));
            this.matches.set(key, pairs);
          }
          const usedA = new Set<number>();
          const usedB = new Set<number>();
          const baseA = this.baseColor(recA, this.project!.styles[A.id]?.fill);
          const baseB = this.baseColor(recB, this.project!.styles[B.id]?.fill);
          // Emparejados (LCS): posición, escala y color interpolados de A a B con `smooth`.
          for (const [ai, bi] of pairs) {
            usedA.add(ai);
            usedB.add(bi);
            const sa = this.stageBounds(A, geoA, [ai]);
            const sb = this.stageBounds(B, geoB, [bi]);
            const ratio = Math.sqrt((sb.w * sb.h) / Math.max(1e-6, sa.w * sa.h));
            const k = 1 + ((Number.isFinite(ratio) && ratio > 0 ? ratio : 1) - 1) * e;
            moveGroup(A, geoA, [ai], k, 0, this.stageVec(A, (sb.cx - sa.cx) * e, (sb.cy - sa.cy) * e), keep);
            const from = A.glyphStyles?.[ai]?.color ?? baseA;
            const to = B.glyphStyles?.[bi]?.color ?? baseB;
            if (from !== to && e > 0) glyphState(A.id, ai, keep).mix.push([to, e]);
            glyphState(B.id, bi).opacity *= 0;
          }
          // No emparejados: FadeOut con leve contracción hacia los glifos nuevos; FadeIn con leve expansión desde los anteriores.
          const lostA = glyphsOf(A).filter((i) => !usedA.has(i) && i < geoA.length);
          const newB = glyphsOf(B).filter((i) => !usedB.has(i) && i < geoB.length);
          const allA = glyphsOf(A).filter((i) => i < geoA.length);
          const allB = glyphsOf(B).filter((i) => i < geoB.length);
          const centerOf = (o: Obj2D, geo: GlyphGeo[], idx: number[], fallback: number[]) => {
            const list = idx.length ? idx : fallback;
            return list.length ? this.stageBounds(o, geo, list) : null;
          };
          const toward = centerOf(B, geoB, newB, allB);
          const from0 = centerOf(A, geoA, lostA, allA);
          const DRIFT = 0.25;
          for (const i of lostA) {
            if (toward) {
              const own = this.stageBounds(A, geoA, [i]);
              moveGroup(A, geoA, [i], 1 - 0.3 * e, 0, this.stageVec(A, (toward.cx - own.cx) * DRIFT * e, (toward.cy - own.cy) * DRIFT * e), keep);
            }
            glyphState(A.id, i, keep).opacity *= 1 - e;
          }
          for (const j of newB) {
            if (from0) {
              const own = this.stageBounds(B, geoB, [j]);
              moveGroup(B, geoB, [j], 0.7 + 0.3 * e, 0, this.stageVec(B, (from0.cx - own.cx) * DRIFT * (1 - e), (from0.cy - own.cy) * DRIFT * (1 - e)));
            }
            glyphState(B.id, j).opacity *= e;
          }
          break;
        }
      }
    }
    // La copia visual del origen solo muestra los glifos que viajan ahora.
    for (const [objId, moving] of ghostMoving) {
      for (const g of this.objs.get(objId)?.glyphs ?? []) if (!moving.has(g.index)) glyphState(objId, g.index, true).opacity *= 0;
    }
    return { states, rings, glyphStates, frames, ghostStates, ghostGlyphs, hiddenIds, morphs };
  }

  // ------------------------------------------------------------------ transformación de grupo

  /** Categoría de emparejamiento de un objeto dentro de una transformación de grupo. */
  private groupKind(o: Obj2D, largest: number): GroupKind {
    const tool = o.vector?.tool;
    if (tool === 'text') return 'text';
    if (tool === 'line' || tool === 'arrow') return 'line';
    if (o.kind === 'formula' && !o.vector) return 'tex';
    if (tool === 'ellipse' && (objSize(o) <= 60 || objSize(o) <= 0.25 * largest)) return 'point';
    if (tool && GROUP_SHAPE_TOOLS.has(tool)) return 'shape';
    return 'svg';
  }

  /** Contorno de la figura principal en coordenadas del escenario (pose base del objeto). */
  private outlineOf(o: Obj2D): { pts: Pt[]; closed: boolean; el: SVGGeometryElement; k: number } | null {
    const rec = this.objs.get(o.id);
    const el = rec?.svg.querySelector('polygon,polyline,rect,ellipse,circle,path') as SVGGeometryElement | null;
    if (!rec || !el) return null;
    const tag = el.localName;
    const local: Pt[] = [];
    try {
      const list = (tag === 'polygon' || tag === 'polyline') ? (el as unknown as SVGPolygonElement).points : null;
      if (list && list.numberOfItems >= 2) {
        for (let i = 0; i < list.numberOfItems; i++) {
          const q = list.getItem(i);
          local.push({ x: q.x, y: q.y });
        }
      } else if (tag === 'rect') {
        const b = el.getBBox();
        local.push({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height });
      } else {
        const len = el.getTotalLength();
        if (!(len > 0)) return null;
        for (let i = 0; i < OUTLINE_SAMPLES; i++) {
          const q = el.getPointAtLength((len * i) / OUTLINE_SAMPLES);
          local.push({ x: q.x, y: q.y });
        }
      }
    } catch {
      return null;
    }
    const ctm = el.getCTM();
    if (local.length < 2 || !ctm) return null;
    const m = DOMMatrix.fromMatrix(ctm);
    const th = (o.rotation * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const pts = local.map((pt) => {
      const q = m.transformPoint(new DOMPoint(pt.x, pt.y));
      const vx = (q.x - o.bw / 2) * o.scale;
      const vy = (q.y - o.bh / 2) * o.scale;
      return { x: o.x + vx * cos - vy * sin, y: o.y + vx * sin + vy * cos };
    });
    const closed = tag === 'polygon' || tag === 'rect' || tag === 'ellipse' || tag === 'circle'
      || (tag === 'path' && /z\s*$/i.test(el.getAttribute('d') ?? ''));
    return { pts, closed, el, k: Math.hypot(m.a, m.b) * Math.abs(o.scale) };
  }

  /** Pintura base de la figura: overrides del inspector, si no atributos del SVG, si no estilo calculado. */
  private basePaint(o: Obj2D, el: Element, k: number): ShapePaint {
    const styles = this.project?.styles ?? {};
    const childId = el.getAttribute('data-mm-id');
    const st: NodeStyle = { ...(styles[o.id] ?? {}), ...(childId && childId !== o.id ? styles[childId] ?? {} : {}) };
    const cs = getComputedStyle(el);
    const solid = (value: string | null | undefined) => (value && !value.startsWith('url(') ? value : null);
    const gradientColor = st.fillGradient && st.fillGradient.mode !== 'solid' ? st.fillGradient.stops[0]?.color : undefined;
    const fill = gradientColor ?? solid(st.fill) ?? solid(el.getAttribute('fill')) ?? solid(cs.fill) ?? 'none';
    const stroke = solid(st.stroke) ?? solid(el.getAttribute('stroke')) ?? solid(cs.stroke) ?? 'none';
    const sw = st.strokeWidth ?? (Number(el.getAttribute('stroke-width')) || parseFloat(cs.strokeWidth) || 0);
    const fo = st.fillOpacity ?? (el.getAttribute('fill-opacity') !== null ? Number(el.getAttribute('fill-opacity')) : 1);
    return { fill, fillOpacity: Number.isFinite(fo) ? fo : 1, stroke, strokeWidth: sw * k };
  }

  /**
   * Emparejamiento de una transformación de grupo. La figura principal (la de mayor tamaño) de cada grupo se
   * deforma en la otra; el resto se empareja por categoría y cercanía de centros (relativos al centro de cada grupo).
   */
  private groupPlan(spec: GroupTransformSpec): GroupPlan {
    const A = spec.sourceObjectIds.map((id) => this.obj2d(id)).filter((o): o is Obj2D => !!o && this.objs.has(o.id));
    const B = spec.targetObjectIds.map((id) => this.obj2d(id)).filter((o): o is Obj2D => !!o && this.objs.has(o.id));
    const sig = (o: Obj2D) => `${o.id}:${o.x},${o.y},${o.scale},${o.rotation},${o.bw},${o.bh},${o.markup.length}`;
    const key = `${this.measureKey}#${A.map(sig).join('|')}#${B.map(sig).join('|')}`;
    const hit = this.groupPlans.get(key);
    if (hit) return hit;

    const largest = (list: Obj2D[]) => list.reduce((m, o) => Math.max(m, objSize(o)), 0);
    const kinds = new Map<Obj2D, GroupKind>();
    const la = largest(A);
    const lb = largest(B);
    for (const o of A) kinds.set(o, this.groupKind(o, la));
    for (const o of B) kinds.set(o, this.groupKind(o, lb));
    const mainOf = (list: Obj2D[]) => list.filter((o) => kinds.get(o) === 'shape').sort((x, y) => objSize(y) - objSize(x))[0];
    const mainA = mainOf(A);
    const mainB = mainOf(B);
    let morph: GroupPlan['morph'] = null;
    if (mainA && mainB) {
      const oa = this.outlineOf(mainA);
      const ob = this.outlineOf(mainB);
      if (oa && ob) {
        const closed = oa.closed && ob.closed;
        const n = Math.max(oa.pts.length, ob.pts.length);
        const ptsA = resampleOutline(oa.pts, n, oa.closed);
        const ptsB = alignOutline(ptsA, resampleOutline(ob.pts, n, ob.closed), closed);
        morph = { a: mainA, b: mainB, ptsA, ptsB, closed, paintA: this.basePaint(mainA, oa.el, oa.k), paintB: this.basePaint(mainB, ob.el, ob.k) };
      }
    }
    const restA = A.filter((o) => o !== morph?.a);
    const restB = B.filter((o) => o !== morph?.b);
    const center = (list: Obj2D[]) => list.length
      ? list.reduce((c, o) => ({ x: c.x + o.x / list.length, y: c.y + o.y / list.length }), { x: 0, y: 0 })
      : { x: 0, y: 0 };
    const ca = center(A);
    const cb = center(B);
    const candidates: { a: Obj2D; b: Obj2D; d: number }[] = [];
    for (const a of restA) for (const b of restB) {
      if (kinds.get(a) !== kinds.get(b)) continue;
      candidates.push({ a, b, d: Math.hypot(b.x - cb.x - (a.x - ca.x), b.y - cb.y - (a.y - ca.y)) });
    }
    candidates.sort((x, y) => x.d - y.d);
    const usedA = new Set<Obj2D>();
    const usedB = new Set<Obj2D>();
    const pairs: [Obj2D, Obj2D][] = [];
    for (const { a, b } of candidates) {
      if (usedA.has(a) || usedB.has(b)) continue;
      usedA.add(a);
      usedB.add(b);
      pairs.push([a, b]);
    }
    // Sin figura deformable en ambos lados, las figuras principales se emparejan como un par más.
    const plan: GroupPlan = { morph, pairs, extraA: restA.filter((o) => !usedA.has(o)), extraB: restB.filter((o) => !usedB.has(o)) };
    if (this.groupPlans.size > 32) this.groupPlans.clear();
    this.groupPlans.set(key, plan);
    return plan;
  }

  /**
   * Estado de una transformación de grupo en el instante dado (`raw` = progreso sin recortar). Antes del inicio
   * el grupo destino ya está oculto (ver `revealAt`); al terminar, el origen se oculta salvo con `keepSource`.
   */
  private applyGroupTransform(
    c: Clip, spec: GroupTransformSpec, raw: number, get: (id: string, ghost?: boolean) => NState, morphs: Morph[], hiddenIds: Set<string>,
  ) {
    if (raw < 0) return;
    const keep = spec.keepSource;
    if (raw >= 1) {
      if (!keep) {
        for (const id of spec.sourceObjectIds) {
          if (!this.nodes.has(id)) continue;
          get(id).opacity *= 0;
          hiddenIds.add(id);
        }
      }
      return;
    }
    const plan = this.groupPlan(spec);
    const p = clamp01(raw);
    const e = smooth(p);
    if (plan.morph) {
      const { a, b, ptsA, ptsB, closed, paintA, paintB } = plan.morph;
      // Durante la deformación solo se ve la capa interpolada (el origen permanece si se mantiene).
      if (!keep) get(a.id).opacity *= 0;
      get(b.id).opacity *= 0;
      const pts = ptsA.map((q, i) => ({ x: q.x + (ptsB[i].x - q.x) * e, y: q.y + (ptsB[i].y - q.y) * e }));
      const d = 'M' + pts.map((q) => `${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join('L') + (closed ? 'Z' : '');
      morphs.push({ key: c.id, afterId: a.id, d, paint: mixPaint(paintA, paintB, e) });
    }
    for (const [a, b] of plan.pairs) {
      // Cada par viaja junto: el origen se desvanece mientras el destino aparece en la misma pose interpolada.
      const ratio = objSize(b) / objSize(a);
      const k = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      const sa = get(a.id, keep);
      sa.dx += (b.x - a.x) * e;
      sa.dy += (b.y - a.y) * e;
      sa.rot += (b.rotation - a.rotation) * e;
      sa.scale *= 1 + (k - 1) * e;
      sa.opacity *= 1 - e;
      const sb = get(b.id);
      sb.dx += (a.x - b.x) * (1 - e);
      sb.dy += (a.y - b.y) * (1 - e);
      sb.rot += (a.rotation - b.rotation) * (1 - e);
      sb.scale *= 1 + (1 / k - 1) * (1 - e);
      sb.opacity *= e;
    }
    // Sobrantes del destino: brotan desde su centro en el tramo 0.4 → 1.
    const grow = smooth(clamp01((p - 0.4) / 0.6));
    for (const b of plan.extraB) {
      const s = get(b.id);
      s.scale *= Math.max(1e-3, grow);
      s.opacity *= grow;
    }
    // Sobrantes del origen: se contraen en la primera mitad (con «Mantener grupo origen» permanecen).
    if (!keep) {
      const shrink = smooth(clamp01(p / 0.5));
      for (const a of plan.extraA) {
        const s = get(a.id);
        s.scale *= Math.max(1e-3, 1 - shrink);
        s.opacity *= 1 - shrink;
      }
    }
  }

  /** Crea, actualiza o retira las capas de deformación (una por transformación de grupo en curso). */
  private syncMorphs(morphs: Morph[]) {
    const live = new Set<string>();
    const NS = 'http://www.w3.org/2000/svg';
    const { w, h } = STAGE_SIZES[this.project!.format];
    for (const m of morphs) {
      const after = this.objs.get(m.afterId)?.wrapper;
      if (!after) continue;
      live.add(m.key);
      let rec = this.morphEls.get(m.key);
      if (!rec) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mm-obj';
        wrapper.dataset.kind = 'morph';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.transform = 'translate(0px,0px)';
        const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
        svg.setAttribute('overflow', 'visible');
        const path = document.createElementNS(NS, 'path') as SVGPathElement;
        path.setAttribute('stroke-linejoin', 'round');
        path.style.pointerEvents = 'none';
        svg.appendChild(path);
        wrapper.appendChild(svg);
        rec = { wrapper, svg, path };
        this.morphEls.set(m.key, rec);
      }
      rec.wrapper.style.width = `${w}px`;
      rec.wrapper.style.height = `${h}px`;
      rec.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      if (rec.wrapper.previousElementSibling !== after) after.after(rec.wrapper);
      const { paint } = m;
      rec.path.setAttribute('d', m.d);
      rec.path.setAttribute('fill', paint.fill);
      rec.path.setAttribute('fill-opacity', paint.fillOpacity.toFixed(3));
      rec.path.setAttribute('stroke', paint.stroke);
      rec.path.setAttribute('stroke-width', paint.strokeWidth.toFixed(2));
    }
    for (const [key, rec] of this.morphEls) {
      if (live.has(key)) continue;
      rec.wrapper.remove();
      this.morphEls.delete(key);
    }
  }

  private drawRings(rings: Ring[], frames: Frame[] = []) {
    const fx = this.els.fx;
    const count = rings.length + frames.length;
    if (!count && !this.ringsDrawn) return;
    while (fx.firstChild) fx.removeChild(fx.firstChild);
    this.ringsDrawn = count > 0;
    if (!count || !this.project) return;
    for (const frame of frames) this.drawFrame(fx, frame);
    const NS = 'http://www.w3.org/2000/svg';
    for (const r of rings) {
      const b = this.getBox(r.targetId);
      if (!b) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const max = r.max ?? Math.max(90, Math.hypot(b.w, b.h) * 0.45 + 50);
      for (let i = 0; i < 2; i++) {
        const pp = clamp01(r.p * 1.35 - i * 0.28);
        if (pp <= 0 || pp >= 1) continue;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', cx.toFixed(1));
        c.setAttribute('cy', cy.toFixed(1));
        c.setAttribute('r', (easeOut(pp) * max).toFixed(1));
        c.setAttribute('fill', 'none');
        c.setAttribute('stroke', r.color);
        c.setAttribute('stroke-width', (2 + 8 * (1 - pp)).toFixed(1));
        c.setAttribute('opacity', (1 - pp).toFixed(3));
        fx.appendChild(c);
      }
    }
  }

  /** Marco luminoso (Circumscribe) o foco que se encoge (FocusOn) sobre un objeto o sus glifos. */
  private drawFrame(fx: SVGSVGElement, f: Frame) {
    const b = this.selectionBox(f.targetId, f.glyphs);
    if (!b || !this.project) return;
    const NS = 'http://www.w3.org/2000/svg';
    const { w, h } = STAGE_SIZES[this.project.format];
    if (f.kind === 'focus') {
      const e = easeInOut(f.p);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', (b.x + b.w / 2).toFixed(1));
      c.setAttribute('cy', (b.y + b.h / 2).toFixed(1));
      c.setAttribute('r', (Math.hypot(w, h) * (1 - e)).toFixed(1));
      c.setAttribute('fill', f.color);
      c.setAttribute('fill-opacity', (f.opacity * e).toFixed(3));
      fx.appendChild(c);
      return;
    }
    const pad = Math.max(8, h * 0.0125);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', (b.x - pad).toFixed(1));
    r.setAttribute('y', (b.y - pad).toFixed(1));
    r.setAttribute('width', (b.w + 2 * pad).toFixed(1));
    r.setAttribute('height', (b.h + 2 * pad).toFixed(1));
    r.setAttribute('rx', (pad / 2).toFixed(1));
    r.setAttribute('pathLength', '1');
    // ShowPassingFlash: una ventana de 30 % del contorno recorre el marco.
    const head = f.p * 1.3;
    const hi = Math.min(1, head);
    const lo = Math.max(0, head - 0.3);
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', f.color);
    r.setAttribute('stroke-width', Math.max(3, h / 270).toFixed(1));
    r.setAttribute('stroke-linecap', 'round');
    r.setAttribute('stroke-dasharray', `${Math.max(0, hi - lo).toFixed(4)} 2`);
    r.setAttribute('stroke-dashoffset', (-lo).toFixed(4));
    r.setAttribute('style', `filter:drop-shadow(0 0 ${Math.max(6, h / 120).toFixed(1)}px ${f.color})`);
    fx.appendChild(r);
  }

  dispose() {
    this.restoreAll();
    for (const rec of this.objs.values()) rec.wrapper.remove();
    for (const ghost of this.ghosts.values()) ghost.wrapper.remove();
    this.ghosts.clear();
    for (const morph of this.morphEls.values()) morph.wrapper.remove();
    this.morphEls.clear();
    this.objs.clear();
    this.nodes.clear();
  }
}
