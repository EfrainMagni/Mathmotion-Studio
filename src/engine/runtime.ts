import { STAGE_SIZES, is2D, type Box, type Clip, type Obj2D, type Obj3D, type Project, type Shape3D, type Vertex } from '../types';
import { vertexAttributes, vertexGeometry } from './vertices';
import { SELECTABLE_SHAPES } from './svgImport';
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

interface ObjRec {
  id: string;
  kind: 'svg' | 'formula';
  markup: string;
  wrapper: HTMLDivElement;
  svg: SVGSVGElement;
  rootId: string;
  lastCss: string;
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
  private origInline = new WeakMap<Element, Map<string, string>>();
  private baseOp = new WeakMap<Element, number>();
  private geomCache = new WeakMap<Element, GeomInfo>();
  private vertexEdits = new Map<string, { element: Element; original: Element; points: Vertex[]; keys: string[] }>();
  private pivots = new WeakMap<Element, { x: number; y: number }>();
  private measureKey = '';
  private ringsDrawn = false;
  private sync3dToken = 0;

  constructor(
    private els: RuntimeEls,
    private hooks: RuntimeHooks = {},
  ) {}

  /** Escala CSS actual del escenario (vista previa reducida). Solo afecta a medidas del contorno de dibujo. */
  setScale(k: number) {
    this.k = k;
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
    this.applied.clear();
    return { id: o.id, kind: o.kind, markup: o.markup, wrapper, svg, rootId: o.id, lastCss: '' };
  }

  private unmount(rec: ObjRec) {
    for (const [id, n] of this.nodes) if (n.objId === rec.id) this.nodes.delete(id);
    rec.wrapper.remove();
    this.applied.clear();
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

    const { states, rings, camAz } = this.computeStates(p.clips, t);

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
      const count = geoms.length;
      if (!count) continue;
      const win = count > 1 ? 0.5 : 0.8;
      const stagger = count > 1 ? (0.8 - win) / (count - 1) : 0;
      geoms.forEach((el, i) => {
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
    this.drawRings(rings);

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
    let camAz = 0;
    const get = (id: string): NState => {
      let s = states.get(id);
      if (!s) {
        s = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0, rot3: { x: 0, y: 0, z: 0 }, glow: 0, glowColor: '#fde047', draw: null };
        states.set(id, s);
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
        case 'draw':
          get(c.targetId).draw = p;
          break;
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
      }
    }
    return { states, rings, camAz };
  }

  private drawRings(rings: Ring[]) {
    const fx = this.els.fx;
    if (!rings.length && !this.ringsDrawn) return;
    while (fx.firstChild) fx.removeChild(fx.firstChild);
    this.ringsDrawn = rings.length > 0;
    if (!rings.length || !this.project) return;
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
    this.objs.clear();
    this.nodes.clear();
  }
}

export { defaultState3D };
