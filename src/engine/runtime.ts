import { STAGE_SIZES, is2D, type Box, type Clip, type Obj2D, type Obj3D, type Project, type Shape3D, type Vertex } from '../types';
import { vertexAttributes, vertexGeometry } from './vertices';
import { SELECTABLE_SHAPES } from './svgImport';
import { clipGlyphs, findGlyphElements, glyphChar, matchGlyphs, mixColor } from './glyphs';
import { Scene3D, defaultState3D, type State3D } from './three3d';

/**
 * SceneRuntime: dueño del DOM del escenario (capa SVG, capa de efectos, capa 3D).
 *
 * Principio: el aspecto en el instante `t` es una función pura de (proyecto, t).
 * `renderAt(t)` parte siempre del estado base y aplica cada clip según su progreso,
 * de modo que avanzar, retroceder o saltar da siempre el mismo resultado.
 * El runtime no depende de GSAP: la línea de tiempo maestra (playback.ts) solo le dice qué `t` dibujar.
 */

const PAINT_SEL = 'path,line,circle,ellipse,rect,polyline,polygon,text';
const NON_RENDERED_SEL = 'defs,clipPath,mask,pattern,symbol,marker';
const GEOM_TAGS = new Set(['path', 'line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon']);

type Props = Record<string, string>;

export interface NodeInfo {
  id: string;
  name: string;
  tag: string;
  kind: 'root-svg' | 'formula' | 'group' | 'shape' | 'text' | 'shape3d';
  objId: string;
  isRoot: boolean;
  shape3d?: Shape3D;
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
  host3d: HTMLElement;
}

export interface RuntimeHooks {
  onWebgl?: (status: 'idle' | 'loading' | 'ready' | 'unavailable', message: string | null) => void;
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
  rot3: { x: number; y: number; z: number };
  glow: number;
  glowColor: string;
  draw: number | null;
  /** `lag_ratio` de Write; `null` conserva el escalonado por defecto. */
  lag: number | null;
}

/** Efecto de un glifo (dx, dy en px del objeto; el resto relativo al estado base). */
interface GState {
  opacity: number;
  dx: number;
  dy: number;
  sc: number;
  rot: number;
  mix: [string, number][];
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

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
export const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

export class SceneRuntime {
  time = 0;
  private project: Project | null = null;
  private objs = new Map<string, ObjRec>();
  private nodes = new Map<string, NodeRec>();
  private scene3d: Scene3D | null = null;
  private creating3d: Promise<void> | null = null;
  private webglError: string | null = null;
  private alive = true;
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
  private ringsDrawn = false;
  private matches = new Map<string, [number, number][]>();
  private sync3dToken = 0;

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
   * y los `<canvas>` WebGL de la capa 3D, que deben copiarse en el mismo turno en que se dibujaron.
   */
  snapshotScene(W: number, H: number, safe = false): { svg: string; gl: HTMLCanvasElement[] } {
    const ser = new XMLSerializer();
    const parts: string[] = [];
    // Propiedades que en la copia aislada (imagen SVG) ya no heredan las hojas de estilo de la página.
    const INLINE = [
      'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
      'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
      'text-anchor', 'visibility', 'display',
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
    return { svg, gl: Array.from(this.els.host3d.querySelectorAll('canvas')) };
  }

  // ------------------------------------------------------------------ proyecto

  setProject(p: Project) {
    this.project = p;
    const list = p.objects.filter(is2D);
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
    this.scene3d?.resize(w, h);

    this.syncVertexEdits(p.styles);
    this.renderAt(this.time);
    if (treeChanged) this.hooks.onTree?.();
    void this.sync3D();
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
          return { index, el, parent: el.parentNode as SVGGraphicsElement, char: glyphChar(el) };
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
    const o = this.project?.objects.find((x) => x.id === id);
    if (o && o.kind === 'shape3d') {
      return { id, name: o.name, tag: o.shape, kind: 'shape3d', objId: id, isRoot: true, shape3d: o.shape };
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
    if (!rec || rec.kind === 'formula' || shift || this.project?.objects.some((o) => o.id === objId && is2D(o) && o.vector)) return objId;
    let el: Element | null = target;
    while (el && el !== rec.svg) {
      const id = el.getAttribute('data-mm-id');
      if (id && this.nodes.has(id) && SELECTABLE_SHAPES.has(el.localName.toLowerCase())) return id;
      el = el.parentElement;
    }
    return objId;
  }

  getVertexTarget(id: string) {
    const node = this.nodes.get(id);
    if (!node) return null;
    const object = this.project?.objects.find((entry) => entry.id === node.objId);
    if (!object || !is2D(object) || object.kind === 'formula') return null;
    const svg = this.objs.get(node.objId)?.svg;
    const native = object.vector?.tool === 'polygon' || object.vector?.tool === 'rectangle';
    if (native) {
      const element = svg?.querySelector<SVGGraphicsElement>('polygon, rect');
      const matrix = element?.getScreenCTM();
      if (!matrix) return null;
      const points = object.vector?.vertices ?? [
        { x: 0, y: 0 }, { x: object.bw, y: 0 }, { x: object.bw, y: object.bh }, { x: 0, y: object.bh },
      ];
      return { id: object.id, native: object, points, matrix };
    }
    if (object.vector) return null;
    const element = (node.isRoot ? svg : node.el) as SVGGraphicsElement | undefined;
    if (!element) return null;
    const candidates = [element, ...element.querySelectorAll<SVGGraphicsElement>('polygon, polyline, line, path')];
    const editable = candidates.flatMap((candidate) => {
      const target = candidate.getAttribute('data-mm-id');
      if (!target || !this.nodes.has(target)) return [];
      const points = vertexGeometry(candidate);
      return points && points.length <= 2048 ? [{ target, candidate, points }] : [];
    });
    if (editable.length !== 1) return null;
    const leaf = editable[0];
    const matrix = leaf.candidate.getScreenCTM();
    return matrix ? { id: leaf.target, native: null, points: leaf.points, matrix } : null;
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
      const polygon = this.project?.objects.some((object) => object.id === id && is2D(object) && object.vector?.tool === 'polygon');
      const el = (polygon && svg?.querySelector('polygon')) || svg || n.el;
      const r = el.getBoundingClientRect();
      const sr = this.els.stage.getBoundingClientRect();
      if (!sr.width || !sr.height) return null;
      const { w, h } = STAGE_SIZES[this.project!.format];
      const kx = w / sr.width;
      const ky = h / sr.height;
      return { x: (r.left - sr.left) * kx, y: (r.top - sr.top) * ky, w: r.width * kx, h: r.height * ky };
    }
    return this.scene3d?.getBox(id) ?? null;
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
    return o && is2D(o) ? o : undefined;
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

  private geomsOf(n: NodeRec): Element[] {
    const base = n.isRoot ? this.objs.get(n.id)!.svg : n.el;
    const list = base.matches(PAINT_SEL) ? [base] : Array.from(base.querySelectorAll(PAINT_SEL));
    return list.filter((e) => !e.closest(NON_RENDERED_SEL));
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
      p.objects.filter(is2D).map((o) => `${o.id}:${o.markup.length}`).join('|') +
      '#' +
      Object.entries(p.styles)
        .map(([id, s]) => `${id}:${s.fill ?? ''},${s.stroke ?? ''},${s.strokeWidth ?? ''}`)
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

    const { states, rings, camAz, glyphStates, frames, ghostStates, ghostGlyphs } = this.computeStates(p.clips, t);

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
    const styled = Object.entries(p.styles)
      .filter(([, s]) => s.fill !== undefined || s.stroke !== undefined || s.strokeWidth !== undefined || s.lineStyle !== undefined)
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
    for (const n of styled) {
      const s = p.styles[n.id];
      for (const el of this.geomsOf(n)) {
        const pr = P(el);
        if (s.fill !== undefined) pr.fill = s.fill;
        if (s.stroke !== undefined) pr.stroke = s.stroke;
        if (s.strokeWidth !== undefined) pr['stroke-width'] = String(s.strokeWidth);
        if (s.lineStyle) {
          const width = Number(pr['stroke-width'] ?? this.geomInfo(el).sw) || 1;
          pr['stroke-dasharray'] = s.lineStyle === 'dotted' ? `0 ${width * 2.5}` : 'none';
          if (s.lineStyle === 'dotted') pr['stroke-linecap'] = 'round';
          else delete pr['stroke-linecap'];
        }
      }
    }

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
      if (!is2D(o) || o.kind !== 'formula') continue;
      const rec = this.objs.get(o.id);
      const effects = glyphStates.get(o.id);
      if (!rec || !rec.glyphs.length || (!o.glyphStyles && !effects)) continue;
      glyphFx(o, rec, effects, (g) => g.el);
    }

    // 2c) copias visuales de la ecuación origen («Mantener ecuación origen»)
    const liveGhosts = new Set<string>();
    for (const o of p.objects) {
      if (!is2D(o)) continue;
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
      if (!is2D(o)) continue;
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
      const sig = `${css}|${op}|${filter}`;
      if (sig !== rec.lastCss) {
        rec.lastCss = sig;
        rec.wrapper.style.transform = css;
        rec.wrapper.style.opacity = op;
        rec.wrapper.style.filter = filter;
      }
    }

    // 4) Escribir / Dibujar
    for (const [id, st] of states) {
      if (st.draw === null || st.draw >= 1) continue;
      const n = this.nodes.get(id);
      if (!n) continue;
      const geoms = this.geomsOf(n);
      if (!geoms.length) continue;
      const glyphCount = n.isRoot ? this.objs.get(id)?.glyphs.length ?? 0 : 0;
      const count = glyphCount || geoms.length;
      const lag = st.lag;
      const win = count > 1 ? (lag !== null ? 0.8 / (1 + (count - 1) * lag) : 0.5) : 0.8;
      const stagger = count > 1 ? (lag !== null ? lag * win : (0.8 - win) / (count - 1)) : 0;
      geoms.forEach((el, k) => {
        // En fórmulas el escalonado es por glifo (como los submobjects de MathTex).
        const i = glyphCount ? Number(el.closest('[data-mm-glyph]')?.getAttribute('data-mm-glyph') ?? k) : k;
        const info = this.geomInfo(el);
        const ps = clamp01((st.draw! - i * stagger) / win);
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

    // 5) Radar (capa de efectos del escenario)
    this.drawRings(rings, frames);

    // 6) 3D
    if (this.scene3d) {
      const objs3 = p.objects.filter((o): o is Obj3D => o.kind === 'shape3d');
      const st3 = new Map<string, State3D>();
      for (const { id } of objs3) {
        const s = states.get(id);
        st3.set(id, {
          opacity: (s?.opacity ?? 1) * (p.styles[id]?.opacity ?? 1),
          dx: (s?.dx ?? 0) + (p.styles[id]?.tx ?? 0),
          dy: (s?.dy ?? 0) + (p.styles[id]?.ty ?? 0),
          scale: s?.scale ?? 1,
          rot: s?.rot3 ?? { x: 0, y: 0, z: 0 },
          glow: s?.glow ?? 0,
          draw: s?.draw ?? null,
        });
      }
      this.scene3d.apply(objs3, st3, p.camera, camAz);
    }
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

  private computeStates(clips: Clip[], t: number) {
    const states = new Map<string, NState>();
    const rings: Ring[] = [];
    const frames: Frame[] = [];
    const glyphStates = new Map<string, Map<number, GState>>();
    /** Estados de las copias visuales (clips con «Mantener ecuación origen»). */
    const ghostStates = new Map<string, NState>();
    const ghostGlyphs = new Map<string, Map<number, GState>>();
    let camAz = 0;
    const glyphState = (objId: string, index: number, ghost = false): GState => {
      const store = ghost ? ghostGlyphs : glyphStates;
      let list = store.get(objId);
      if (!list) store.set(objId, (list = new Map()));
      let g = list.get(index);
      if (!g) list.set(index, (g = { opacity: 1, dx: 0, dy: 0, sc: 1, rot: 0, mix: [], glow: 0, glowColor: '#fde047' }));
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
        s = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0, rot3: { x: 0, y: 0, z: 0 }, glow: 0, glowColor: '#fde047', draw: null, lag: null };
        store.set(id, s);
      }
      return s;
    };
    const is3d = (id: string) => this.project!.objects.some((o) => o.id === id && o.kind === 'shape3d');
    const sorted = clips.slice().sort((a, b) => a.start - b.start);
    for (const c of sorted) {
      if (!this.nodes.has(c.targetId) && !is3d(c.targetId)) continue;
      const raw = (t - c.start) / c.duration;
      const p = clamp01(raw);
      const live = raw >= 0 && raw <= 1;
      const par = c.parameters;
      switch (c.type) {
        case 'draw': {
          const s = get(c.targetId);
          s.draw = p;
          s.lag = typeof par.lagRatio === 'number' && par.lagRatio >= 0 ? par.lagRatio : null;
          break;
        }
        case 'appear': {
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
          if (is3d(c.targetId)) {
            const axis = str(par.axis, 'y') as 'x' | 'y' | 'z';
            s.rot3[axis] += r;
          } else s.rot += r;
          break;
        }
        case 'radar':
          if (live) rings.push({ targetId: c.targetId, p, color: str(par.color, '#38bdf8'), max: typeof par.size === 'number' ? par.size : null });
          break;
        case 'orbit':
          camAz += num(par.angle, 180) * easeInOut(p);
          break;
        case 'indicate': {
          if (!live) break;
          const b = easeInOut(p < 0.5 ? 2 * p : 2 - 2 * p);
          if (b <= 0) break;
          const factor = num(par.scale, 1.3);
          const color = str(par.color, '#ffff00');
          const fo = this.formulaOf(c.targetId);
          const rec = fo && this.objs.get(fo.id);
          const geo = rec ? this.geoOf(rec) : null;
          if (fo && geo) {
            const idx = (clipGlyphs(fo, par) ?? glyphsOf(fo)).filter((i) => i < geo.length);
            moveGroup(fo, geo, idx, 1 + (factor - 1) * b, 0, { x: 0, y: 0 });
            for (const i of idx) {
              const g = glyphState(fo.id, i);
              g.mix.push([color, b]);
              if (b > g.glow) {
                g.glow = b;
                g.glowColor = color;
              }
            }
          } else {
            const s = get(c.targetId);
            s.scale *= 1 + (factor - 1) * b;
            if (b > s.glow) {
              s.glow = b;
              s.glowColor = color;
            }
          }
          break;
        }
        case 'circumscribe':
        case 'focus': {
          if (!live) break;
          const fo = this.formulaOf(c.targetId);
          frames.push({
            kind: c.type, targetId: c.targetId, glyphs: fo ? clipGlyphs(fo, par) : null, p,
            color: str(par.color, c.type === 'focus' ? '#888888' : '#ffff00'), opacity: num(par.opacity, 0.2),
          });
          break;
        }
        case 'transform': {
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
          const e = easeInOut(p);
          const key = `${A.id}|${B.id}|${recA.markup.length}|${recB.markup.length}`;
          let pairs = this.matches.get(key);
          if (!pairs) {
            pairs = matchGlyphs(recA.glyphs.map((g) => g.char), recB.glyphs.map((g) => g.char));
            this.matches.set(key, pairs);
          }
          const usedA = new Set<number>();
          const usedB = new Set<number>();
          const baseA = this.baseColor(recA, this.project!.styles[A.id]?.fill);
          const baseB = this.baseColor(recB, this.project!.styles[B.id]?.fill);
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
          for (const i of glyphsOf(A)) if (!usedA.has(i)) glyphState(A.id, i, keep).opacity *= 1 - e;
          for (const i of glyphsOf(B)) if (!usedB.has(i)) glyphState(B.id, i).opacity *= e;
          break;
        }
      }
    }
    return { states, rings, camAz, glyphStates, frames, ghostStates, ghostGlyphs };
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

  // ------------------------------------------------------------------ 3D

  private async sync3D() {
    const p = this.project;
    if (!p || !this.alive) return;
    const token = ++this.sync3dToken;
    const objs3 = p.objects.filter((o): o is Obj3D => o.kind === 'shape3d');
    if (!objs3.length) {
      if (this.scene3d) {
        this.scene3d.dispose(); // libera WebGL al retirar el último objeto 3D
        this.scene3d = null;
      }
      this.webglError = null;
      this.hooks.onWebgl?.('idle', null);
      return;
    }
    if (!this.scene3d) {
      if (this.webglError) return;
      if (!this.creating3d) {
        this.hooks.onWebgl?.('loading', null);
        const { w, h } = STAGE_SIZES[p.format];
        this.creating3d = Scene3D.create(this.els.host3d, w, h)
          .then((s) => {
            const still = this.alive && this.project?.objects.some((o) => o.kind === 'shape3d');
            if (!still) {
              s.dispose();
              return;
            }
            this.scene3d = s;
            this.hooks.onWebgl?.('ready', null);
          })
          .catch((e: unknown) => {
            this.webglError = e instanceof Error ? e.message : String(e);
            this.hooks.onWebgl?.('unavailable', this.webglError);
          })
          .finally(() => {
            this.creating3d = null;
          });
      }
      await this.creating3d;
    }
    if (token !== this.sync3dToken || !this.scene3d || !this.project) return;
    this.scene3d.sync(
      this.project.objects.filter((o): o is Obj3D => o.kind === 'shape3d'),
      this.project.styles,
    );
    this.renderAt(this.time);
  }

  /** Espera a que la capa 3D esté lista (para la vista de grabación). */
  async whenReady(): Promise<void> {
    await this.sync3D();
  }

  dispose() {
    this.alive = false;
    this.restoreAll();
    this.scene3d?.dispose();
    this.scene3d = null;
    for (const rec of this.objs.values()) rec.wrapper.remove();
    for (const ghost of this.ghosts.values()) ghost.wrapper.remove();
    this.ghosts.clear();
    this.objs.clear();
    this.nodes.clear();
  }
}

export { defaultState3D };
