/**
 * Pruebas de lógica en un navegador real. Se empaquetan con esbuild y se ejecutan con tests/dom-test.mjs.
 * No dependen de React, GSAP ni MathJax: ejercitan el saneado de SVG y el runtime del escenario.
 */
import { SAMPLE_SVG, inlineUses, prepareSvg } from '../src/engine/svgImport';
import { SceneRuntime, type TreeNode } from '../src/engine/runtime';
import { matchGlyphs } from '../src/engine/glyphs';
import { normalizePlane, planeSvg } from '../src/engine/cartesianPlane';
import { generateManim } from '../src/engine/manim';
import type { Clip, NodeStyle, Obj2D, Project } from '../src/types';

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: Result[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail: ok ? undefined : detail });
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function mkProject(objects: Obj2D[], clips: Clip[] = [], styles: Record<string, NodeStyle> = {}): Project {
  return {
    format: '16:9',
    background: 'board',
    objects,
    styles,
    clips,
    voice: null,
    counters: { obj: 9, clip: 9 },
  };
}

function mkObj(id: string, markup: string, bw: number, bh: number, kind: 'svg' | 'formula' = 'svg', scale = 1): Obj2D {
  return { id, kind, name: id, markup, sourceSvg: markup, bw, bh, x: 960, y: 540, scale, rotation: 0 };
}

function mkClip(id: string, targetId: string, type: Clip['type'], start: number, duration: number, parameters: Clip['parameters'] = {}): Clip {
  return { id, targetId, type, start, duration, parameters, sound: null };
}

function mkStage(scale = 1) {
  document.body.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:scale(${scale})`;
  const stage = document.createElement('div');
  stage.style.cssText = 'position:relative;width:1920px;height:1080px;overflow:hidden';
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0';
  const fx = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
  fx.setAttribute('viewBox', '0 0 1920 1080');
  fx.style.cssText = 'position:absolute;inset:0;width:1920px;height:1080px;pointer-events:none';
  stage.append(layer, fx);
  box.append(stage);
  document.body.append(box);
  // regla equivalente a index.css para los objetos montados
  const st = document.createElement('style');
  st.textContent = `.mm-obj{position:absolute;left:0;top:0;transform-origin:50% 50%;pointer-events:none}
.mm-obj>svg{display:block;width:100%;height:100%;pointer-events:none}.mm-obj>svg *{pointer-events:auto}`;
  document.head.append(st);
  const rt = new SceneRuntime({ stage, layer, fx });
  rt.setScale(scale);
  return { rt, stage, layer, fx, scale };
}

function findByName(tree: TreeNode | null, name: string): TreeNode | null {
  if (!tree) return null;
  if (tree.name === name) return tree;
  for (const c of tree.children) {
    const r = findByName(c, name);
    if (r) return r;
  }
  return null;
}
const flat = (t: TreeNode): string[] => [t.name, ...t.children.flatMap(flat)];
const nodeEl = (id: string) => document.querySelector(`[data-mm-id="${id}"]`) as SVGElement;
const centerOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const snapshot = () =>
  Array.from(document.querySelectorAll('[data-mm-obj],[data-mm-id]'))
    .map((e) => `${(e as HTMLElement).dataset.mmObj ?? e.getAttribute('data-mm-id')}=${(e as HTMLElement).style.cssText}`)
    .join('\n');

// --------------------------------------------------------------------------------------------

const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" viewBox="0 0 100 100" onload="alert(1)">
 <script>alert(1)</script>
 <style>@import url(http://evil.test/x.css); .a{fill:url(http://evil.test/p.svg#x)} .b{fill:red;background:url(javascript:alert(1))} @font-face{font-family:x;src:url(http://evil.test/f.woff)} @keyframes k{from{opacity:0}to{opacity:1}}</style>
 <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
 <image href="http://evil.test/a.png" width="10" height="10"/>
 <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="5" height="5"/>
 <use href="http://evil.test/s.svg#a"/>
 <a href="javascript:alert(1)"><rect id="r1" width="10" height="10" onclick="alert(2)" fill="url(http://evil.test/g)"/></a>
 <animate attributeName="x" to="5"/>
 <rect id="ok" class="b" x="20" y="20" width="10" height="10" style="fill:url(#ok2);filter:url(https://evil.test/f.svg#f)"/>
 <linearGradient id="ok2"><stop offset="0" stop-color="#f00"/></linearGradient>
 <i:pgf id="adobe"><![CDATA[xxx]]></i:pgf>
</svg>`;

const ILLUSTRATOR = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 612 792" style="enable-background:new 0 0 612 792;" xml:space="preserve">
<style type="text/css">.st0{fill:#FF0000;}</style>
<g id="Layer_1_1_"><polygon class="st0" points="10,10 100,10 55,90"/></g>
</svg>`;

export async function run(): Promise<Result[]> {
  // ---- 1. Saneado ------------------------------------------------------------------------
  {
    const p = prepareSvg(HOSTILE, 'o9');
    const m = p.markup;
    check('sanea: sin <script>', !/<script/i.test(m), m);
    check('sanea: sin foreignObject', !/foreignObject/i.test(m));
    check('sanea: sin atributos on*', !/\son\w+=/i.test(m), m);
    check('sanea: sin recursos externos', !/evil\.test/.test(m), m);
    check('sanea: sin javascript:', !/javascript:/i.test(m));
    check('sanea: sin <animate> ni elementos de otros espacios de nombres', !/animate|pgf/i.test(m));
    check('sanea: conserva imagen incrustada data:image/png', /data:image\/png;base64/.test(m));
    check('sanea: <a> convertido en grupo sin href', !/<a[\s>]/i.test(m) && !/href="javascript/.test(m));
    check('sanea: referencia interna reescrita con prefijo', /url\(#o9__ok2\)/.test(m), m);
    check('sanea: viewBox conservado', p.viewBox.join(' ') === '0 0 100 100');
    check('sanea: informa advertencias', p.warnings.length > 0);
    const reparse = new DOMParser().parseFromString(m, 'image/svg+xml');
    check('sanea: el resultado vuelve a ser XML válido', !reparse.querySelector('parsererror'));
  }

  // ---- 2. SVG estilo Illustrator (DOCTYPE con entidades, <style> con clases) ---------------
  {
    const p = prepareSvg(ILLUSTRATOR, 'o5');
    check('illustrator: viewBox 612×792 conservado', p.viewBox.join(' ') === '0 0 612 792', p.viewBox.join(' '));
    const { rt } = mkStage();
    rt.setProject(mkProject([mkObj('o5', p.markup, 612, 792)]));
    const poly = document.querySelector('polygon') as SVGElement;
    check('illustrator: estilo de clase aplicado dentro del ámbito', getComputedStyle(poly).fill === 'rgb(255, 0, 0)', getComputedStyle(poly).fill);
    rt.dispose();
  }
  {
    const p = prepareSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200pt" height="100pt"><rect width="50" height="50"/></svg>', 'o6');
    check('sin viewBox: se deriva de width/height (pt→px)', near(p.viewBox[2], 266.67, 0.1) && near(p.viewBox[3], 133.33, 0.1), p.viewBox.join(' '));
    const q = prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="50" height="40"/></svg>', 'o7');
    check('sin viewBox ni tamaño: se deriva del contenido', q.viewBox.join(' ') === '10 20 50 40', q.viewBox.join(' '));
    let err = '';
    try {
      prepareSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect', 'o8');
    } catch (e) {
      err = (e as Error).message;
    }
    check('error claro con XML mal formado', /SVG no válido/.test(err), err);
    err = '';
    try {
      prepareSvg('<html xmlns="http://www.w3.org/1999/xhtml"></html>', 'o8');
    } catch (e) {
      err = (e as Error).message;
    }
    check('error claro si no hay <svg> raíz', /elemento <svg>/.test(err), err);
  }

  // ---- 3. Importación doble, colisiones de IDs y estilos aislados ---------------------------
  const a = prepareSvg(SAMPLE_SVG, 'o1');
  const b = prepareSvg(SAMPLE_SVG, 'o2');
  check('muestra: viewBox 0 0 800 500 conservado', a.viewBox.join(' ') === '0 0 800 500');
  check('muestra: transformación heredada conservada', a.markup.includes('translate(120 400) scale(1.1)'));
  check('muestra: clip-path reescrito', a.markup.includes('url(#o1__frameClip)'));

  const outside = document.createElement('div');
  outside.innerHTML = '<svg id="outside" width="10" height="10"><line class="side" x1="0" y1="0" x2="10" y2="0" stroke="black"/></svg>';
  const { rt, stage, scale } = mkStage(1);
  document.body.append(outside);
  const objs = [mkObj('o1', a.markup, 800, 500, 'svg', 1.4), mkObj('o2', b.markup, 800, 500, 'svg', 0.4)];
  rt.setProject(mkProject(objs));
  rt.renderAt(0);

  const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
  check('doble importación: ids únicos en el documento', new Set(ids).size === ids.length, ids.join(','));
  const vertex = document.querySelector('#o1__vertexGrad');
  const circ1 = document.querySelector('[data-mm-obj="o1"] circle') as SVGElement;
  const circ2 = document.querySelector('[data-mm-obj="o2"] circle') as SVGElement;
  check('doble importación: cada gradiente se resuelve por separado', !!vertex && getComputedStyle(circ1).fill.includes('o1__vertexGrad') && getComputedStyle(circ2).fill.includes('o2__vertexGrad'), `${getComputedStyle(circ1).fill} | ${getComputedStyle(circ2).fill}`);
  const sideLine = document.querySelector('[data-mm-obj="o1"] line') as SVGElement;
  check('estilos del SVG aplican dentro de su ámbito', getComputedStyle(sideLine).stroke === 'rgb(56, 189, 248)', getComputedStyle(sideLine).stroke);
  check('estilos del SVG no se filtran al resto de la aplicación', getComputedStyle(outside.querySelector('line')!).stroke === 'rgb(0, 0, 0)', getComputedStyle(outside.querySelector('line')!).stroke);
  check('style inline tiene prioridad sobre la clase (Lado_b violeta)', (() => {
    const t = rt.getTree('o1')!;
    const el = nodeEl(findByName(t, 'Lado_b')!.id);
    return getComputedStyle(el).stroke === 'rgb(167, 139, 250)';
  })());

  // ---- 4. Jerarquía, orden de dibujo y selección ------------------------------------------
  const tree = rt.getTree('o1')!;
  const order = flat(tree);
  check('árbol: jerarquía Marco › Triangulo › Lados › Lado_b', (() => {
    const lados = findByName(tree, 'Lados')!;
    const tri = findByName(tree, 'Triangulo')!;
    return !!tri.children.find((c) => c.id === lados.id) && lados.children.some((c) => c.name === 'Lado_b');
  })());
  check('árbol: orden de dibujo del documento (Fondo antes que Triangulo)', order.indexOf('Fondo') < order.indexOf('Triangulo') && order.indexOf('Lado_a') < order.indexOf('Vertice_A'), order.join(','));
  check('árbol: no incluye contenido de <defs>', !order.includes('frameClip') && !order.includes('vertexGrad'));

  const ladoB = findByName(tree, 'Lado_b')!;
  const lbEl = nodeEl(ladoB.id);
  const c = centerOf(lbEl);
  const hit = document.elementFromPoint(c.x, c.y);
  const resolved = rt.resolveTarget(hit, false);
  check('selección: clic real sobre un lado dentro de un grupo llega al hijo', resolved === ladoB.id, `hit=${hit?.tagName}#${hit?.getAttribute('data-mm-name')} resolved=${resolved}`);
  check('selección: Mayús selecciona el objeto completo', rt.resolveTarget(hit, true) === 'o1');
  const info = rt.getNodeInfo(ladoB.id)!;
  check('nodo: nombre/ID/tipo para el inspector', info.name === 'Lado_b' && info.tag === 'line' && info.kind === 'shape', JSON.stringify(info));
  check('nodo: ancestros para sincronizar el árbol', rt.getAncestors(ladoB.id).length >= 3);
  const box = rt.getBox(ladoB.id)!;
  const sr = stage.getBoundingClientRect();
  const r = lbEl.getBoundingClientRect();
  check('caja de selección coincide con el elemento', near(box.x * scale, r.left - sr.left, 1) && near(box.h * scale, r.height, 1), JSON.stringify(box));

  // ---- 5. Arrastre: el desplazamiento coincide con el puntero con vista reducida ------------
  for (const k of [1, 0.4]) {
    const s2 = mkStage(k);
    s2.rt.setProject(mkProject([mkObj('o1', a.markup, 800, 500, 'svg', 1.4)]));
    s2.rt.renderAt(0);
    const t2 = s2.rt.getTree('o1')!;
    const id = findByName(t2, 'Lado_b')!.id;
    const el = nodeEl(id);
    const before = centerOf(el);
    const dx = 37;
    const dy = -23;
    const inv = (el.parentNode as SVGGraphicsElement).getScreenCTM()!.inverse();
    const lx = inv.a * dx + inv.c * dy;
    const ly = inv.b * dx + inv.d * dy;
    s2.rt.setProject(mkProject([mkObj('o1', a.markup, 800, 500, 'svg', 1.4)], [], { [id]: { tx: lx, ty: ly } }));
    const after = centerOf(el);
    check(`arrastre hijo (vista ${k * 100}%): sigue al puntero`, near(after.x - before.x, dx, 0.6) && near(after.y - before.y, dy, 0.6), `${after.x - before.x},${after.y - before.y}`);

    const w = document.querySelector('[data-mm-obj="o1"]') as HTMLElement;
    const wb = centerOf(w);
    const rect = s2.stage.getBoundingClientRect();
    const o = mkObj('o1', a.markup, 800, 500, 'svg', 1.4);
    o.x += dx / (rect.width / 1920);
    o.y += dy / (rect.height / 1080);
    s2.rt.setProject(mkProject([o], [], { [id]: { tx: lx, ty: ly } }));
    const wa = centerOf(w);
    check(`arrastre objeto raíz (vista ${k * 100}%): sigue al puntero`, near(wa.x - wb.x, dx, 0.6) && near(wa.y - wb.y, dy, 0.6), `${wa.x - wb.x},${wa.y - wb.y}`);
    s2.rt.dispose();
  }

  // ---- 6. Animaciones como función del tiempo ----------------------------------------------
  const s3 = mkStage(1);
  const rt3 = s3.rt;
  const T = rt3;
  rt3.setProject(mkProject([mkObj('o1', a.markup, 800, 500, 'svg', 1.4)]));
  const tr = rt3.getTree('o1')!;
  const id = (n: string) => findByName(tr, n)!.id;
  const clips = [
    mkClip('c1', id('Lado_a'), 'draw', 0, 1.5),
    mkClip('c2', id('Vertice_A'), 'appear', 1.5, 1.5, { direction: 'left', distance: 150 }),
    mkClip('c3', id('Triangulo'), 'rotate', 3.0, 1.5, { mode: 'angle', angle: 90 }),
    mkClip('c4', id('Hipotenusa'), 'glow', 4.5, 1.5, { color: '#fde047' }),
    mkClip('c5', id('Vertice_B'), 'radar', 3.0, 1.5),
    mkClip('c6', id('Texto_a'), 'draw', 0, 1.0),
    mkClip('c7', id('Vertice_C'), 'draw', 0, 1.0),
  ];
  const project3 = mkProject([mkObj('o1', a.markup, 800, 500, 'svg', 1.4)], clips);
  rt3.setProject(project3);
  const lado = nodeEl(id('Lado_a'));
  const num = (el: Element, prop: string) => parseFloat((el as HTMLElement).style.getPropertyValue(prop));

  T.renderAt(0);
  check('dibujo: t=0 trazo oculto (dashoffset = longitud)', near(num(lado, 'stroke-dashoffset'), 520, 0.5) && lado.style.getPropertyValue('stroke-opacity') === '0', lado.style.cssText);
  T.renderAt(0.75);
  const off = num(lado, 'stroke-dashoffset');
  check('dibujo: a mitad el trazo se revela parcialmente (getTotalLength/dashoffset)', off > 100 && off < 300 && num(lado, 'stroke-dasharray') === 520, `offset=${off}`);
  T.renderAt(1.5);
  check('dibujo: al terminar se restauran las propiedades originales', lado.style.getPropertyValue('stroke-dashoffset') === '' && lado.style.getPropertyValue('stroke-dasharray') === '');

  const vA = nodeEl(id('Vertice_A'));
  T.renderAt(0.2);
  check('aparecer: antes de su inicio el objeto está oculto', num(vA, 'opacity') === 0, vA.style.cssText);
  T.renderAt(2.25);
  check('aparecer: a mitad hay opacidad y desplazamiento parciales', num(vA, 'opacity') > 0.3 && num(vA, 'opacity') < 1 && /^-?\d/.test(vA.style.translate) && parseFloat(vA.style.translate) < 0, vA.style.cssText);
  T.renderAt(3.0);
  check('aparecer: al terminar vuelve al estado base', vA.style.opacity === '' && vA.style.translate === '', vA.style.cssText);

  const tri = nodeEl(id('Triangulo'));
  const attrBefore = tri.getAttribute('transform');
  // Punto que debe permanecer fijo: el centro de la caja local del grupo, llevado a pantalla.
  const pivotOnScreen = () => {
    const g = tri as unknown as SVGGraphicsElement;
    const bb = g.getBBox();
    const p = new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2).matrixTransform(g.getScreenCTM()!);
    return { x: p.x, y: p.y };
  };
  T.renderAt(0);
  const c0 = pivotOnScreen();
  const dims0 = tri.getBoundingClientRect();
  T.renderAt(3.75);
  const rotMid = parseFloat(tri.style.rotate);
  check('rotar: ángulo parcial con suavizado', near(rotMid, 45, 1), `rot=${tri.style.rotate}`);
  T.renderAt(4.5);
  check('rotar: ángulo exacto al terminar', near(parseFloat(tri.style.rotate), 90, 0.01));
  const c1 = pivotOnScreen();
  const dims1 = tri.getBoundingClientRect();
  T.renderAt(8);
  check('rotar: se conserva el ángulo final tras el clip', near(parseFloat(tri.style.rotate), 90, 0.01));
  check('rotar: no se altera el atributo transform original', tri.getAttribute('transform') === attrBefore);

  const hip = nodeEl(id('Hipotenusa'));
  T.renderAt(5.25);
  check('brillar: resplandor a mitad del clip', /drop-shadow/.test(hip.style.filter), hip.style.cssText);
  T.renderAt(6.5);
  check('brillar: se devuelve al estado anterior', hip.style.filter === '' && hip.style.scale === '', hip.style.cssText);

  T.renderAt(3.75);
  check('radar: anillos expansivos durante el clip', s3.fx.querySelectorAll('circle').length >= 1);
  T.renderAt(5.0);
  check('radar: los anillos desaparecen al terminar', s3.fx.querySelectorAll('circle').length === 0);

  const txt = nodeEl(id('Texto_a'));
  T.renderAt(0.5);
  check('texto SVG: aparición progresiva (opacidad)', num(txt, 'opacity') > 0.2 && num(txt, 'opacity') < 0.9, txt.style.cssText);
  const vC = nodeEl(id('Vertice_C'));
  T.renderAt(0.4);
  check('figura con trazo y relleno: el relleno se revela al final', vC.style.getPropertyValue('fill-opacity') === '0' && num(vC, 'stroke-dashoffset') > 0, vC.style.cssText);
  T.renderAt(0.9);
  check('figura con trazo y relleno: relleno parcial cerca del final', num(vC, 'fill-opacity') > 0 && num(vC, 'fill-opacity') < 1, vC.style.cssText);
  T.renderAt(1.2);
  check('figura con trazo y relleno: estado base al terminar', vC.style.getPropertyValue('fill-opacity') === '');

  // Retroceder: el estado debe ser idéntico al de un render directo en ese instante.
  const times = [0, 0.75, 2.25, 3.75, 4.5, 5.25, 8];
  let deterministic = true;
  let why = '';
  const direct = new Map<number, string>();
  for (const t of times) {
    T.renderAt(t);
    direct.set(t, snapshot());
  }
  for (const t of [...times].reverse().concat([1.1, 0.3, 6, 0.75])) {
    T.renderAt(8);
    T.renderAt(t);
    const s = snapshot();
    T.renderAt(0);
    T.renderAt(t);
    if (s !== snapshot()) {
      deterministic = false;
      why = `t=${t}`;
    }
    if (direct.has(t) && direct.get(t) !== s) {
      deterministic = false;
      why = `t=${t} (directo)`;
    }
  }
  check('avanzar y retroceder: opacidad, posición, escala y rotación se recuperan exactamente', deterministic, why);
  T.renderAt(0);
  const lb0 = nodeEl(id('Lado_b')) as HTMLElement;
  check('t=0 tras editar: elementos sin clip conservan su estilo original', lb0.getAttribute('style') === 'stroke:#a78bfa' && lb0.style.translate === '' && lb0.style.rotate === '', lb0.getAttribute('style') ?? 'null');

  {
    // Escena aislada: solo la rotación, para medir el pivote sin otros clips que muevan hijos del grupo.
    const s6 = mkStage(1);
    const o6 = mkObj('o1', a.markup, 800, 500, 'svg', 1.4);
    s6.rt.setProject(mkProject([o6]));
    const triId = findByName(s6.rt.getTree('o1'), 'Triangulo')!.id;
    s6.rt.setProject(mkProject([o6], [mkClip('r1', triId, 'rotate', 0, 1, { mode: 'angle', angle: 90 })]));
    const g = nodeEl(triId) as unknown as SVGGraphicsElement;
    const pv = () => {
      const bb = g.getBBox();
      const p = new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2).matrixTransform(g.getScreenCTM()!);
      return { x: p.x, y: p.y };
    };
    s6.rt.renderAt(0);
    const p0 = pv();
    const d0 = g.getBoundingClientRect();
    s6.rt.renderAt(1);
    const p1 = pv();
    const d1 = g.getBoundingClientRect();
    check('rotar: gira sobre su propio centro aunque el grupo ya tenga atributo transform', near(p1.x, p0.x, 0.5) && near(p1.y, p0.y, 0.5), `${p0.x},${p0.y} → ${p1.x},${p1.y}`);
    check('rotar: 90° intercambia ancho y alto de la caja en pantalla', near(d1.width, d0.height, 0.5) && near(d1.height, d0.width, 0.5), `${d0.width}x${d0.height} → ${d1.width}x${d1.height}`);
    s6.rt.dispose();
  }


  // ---- 7. Figura rellena sin trazo (glifo): contorno y relleno al final -----------------------
  {
    const glyph = prepareSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" style="color:#ffffff"><g fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M10 10 H90 V90 H10Z"/></g></svg>', 'o3');
    const s4 = mkStage(1);
    s4.rt.setProject(mkProject([mkObj('o3', glyph.markup, 100, 100, 'formula', 3)]));
    const p0 = document.querySelector('[data-mm-obj="o3"] path') as SVGElement;
    s4.rt.setProject(mkProject([mkObj('o3', glyph.markup, 100, 100, 'formula', 3)], [mkClip('g1', 'o3', 'draw', 0, 2)]));
    s4.rt.renderAt(0.8);
    const sw = num(p0, 'stroke-width');
    check('glifo relleno: se anima el contorno (stroke = color del relleno, dash parcial)', p0.style.stroke !== '' && sw > 0 && num(p0, 'stroke-dashoffset') > 0 && num(p0, 'stroke-dashoffset') < 320, p0.style.cssText);
    check('glifo relleno: relleno oculto hasta el final', p0.style.getPropertyValue('fill-opacity') === '0');
    s4.rt.renderAt(1.8);
    check('glifo relleno: el relleno aparece al final y el contorno se desvanece', num(p0, 'fill-opacity') > 0 && num(p0, 'stroke-opacity') < 1, p0.style.cssText);
    s4.rt.renderAt(2);
    check('glifo relleno: al terminar queda el glifo original', p0.style.cssText === '');
    s4.rt.dispose();
  }

  // ---- 8. Overrides del inspector --------------------------------------------------------------
  {
    const s5 = mkStage(1);
    const obj = mkObj('o1', a.markup, 800, 500, 'svg', 1);
    s5.rt.setProject(mkProject([obj]));
    const t5 = s5.rt.getTree('o1')!;
    const ladoA = nodeEl(findByName(t5, 'Lado_a')!.id);
    const lados = findByName(t5, 'Lados')!;
    const orig = getComputedStyle(ladoA).stroke;
    s5.rt.setProject(mkProject([obj], [], { [lados.id]: { stroke: '#00ff00' }, [findByName(t5, 'Lado_a')!.id]: { stroke: '#ff0000', strokeWidth: 12 } }));
    check('inspector: override en grupo y en hijo (el más profundo gana)', getComputedStyle(ladoA).stroke === 'rgb(255, 0, 0)' && getComputedStyle(nodeEl(findByName(t5, 'Hipotenusa')!.id)).stroke === 'rgb(0, 255, 0)');
    check('inspector: grosor en vivo', getComputedStyle(ladoA).strokeWidth === '12px');
    s5.rt.setProject(mkProject([obj]));
    check('inspector: quitar overrides restaura el original', getComputedStyle(ladoA).stroke === orig && ladoA.style.cssText === '', ladoA.style.cssText);
    const paint = s5.rt.getPaint(findByName(t5, 'Lado_a')!.id)!;
    check('inspector: lee relleno/trazo efectivos', paint.stroke === 'rgb(56, 189, 248)' && paint.strokeWidth === 6, JSON.stringify(paint));
    s5.rt.dispose();
  }

  // ---- 9. <use> en línea (glifos de MathJax con caché de fuentes) ------------------------------
  {
    const holder = document.createElement('div');
    holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200" viewBox="0 0 400 200"><defs><path id="g1" d="M0 0 L10 0 L10 10 Z"/></defs><g fill="red"><use href="#g1" x="20" y="5"/><use xlink:href="#g1" transform="translate(100 50) scale(2)"/></g></svg>`;
    document.body.append(holder);
    const svg = holder.querySelector('svg')!;
    const before = svg.querySelector('g')!.getBoundingClientRect();
    inlineUses(svg);
    const after = svg.querySelector('g')!.getBoundingClientRect();
    check('inlineUses: sin <use> y sin <defs> huérfanas', svg.querySelectorAll('use').length === 0 && svg.querySelectorAll('defs').length === 0);
    check('inlineUses: conserva posición y tamaño', near(before.left, after.left, 0.5) && near(before.top, after.top, 0.5) && near(before.width, after.width, 0.5) && near(before.height, after.height, 0.5), JSON.stringify([before, after]));
    check('inlineUses: conserva el relleno heredado', getComputedStyle(svg.querySelector('path')!).fill === 'rgb(255, 0, 0)');
  }

  rt3.dispose();
  rt.dispose();
  await glyphTests();
  return results;
}

// ---- 10. Glifos de ecuaciones (MathTex), énfasis y transformaciones ----------------------------

const HEX: Record<string, string> = { '4': '34', x: '1D465', '+': '2B', '5': '35', '=': '3D', '2': '32', '9': '39' };

/** SVG con la misma estructura que MathJax (fontCache none): un `path[data-c]` por glifo y eje y invertido. */
function mathSvg(chars: string[]): string {
  const paths = chars.map((char, i) => {
    const shape = char === '+' || char === '=' ? 'M0 150H400V450H0Z' : 'M0 0H400V600H0Z';
    return `<g data-mml-node="${/\d/.test(char) ? 'mn' : 'mi'}" transform="translate(${i * 600},0)"><path data-c="${HEX[char]}" d="${shape}"/></g>`;
  });
  const width = chars.length * 600;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -750 ${width} 1100" width="100%" height="100%" style="color:#f8fafc"><g stroke="currentColor" fill="currentColor" stroke-width="0" transform="scale(1,-1)"><g data-mml-node="math">${paths.join('')}</g></g></svg>`;
}

function mkFormula(id: string, tex: string, x: number, y: number): Obj2D {
  const chars = [...tex];
  const source = mathSvg(chars);
  const prepared = prepareSvg(source, id);
  return { id, kind: 'formula', name: id, markup: prepared.markup, sourceSvg: source, tex, bw: prepared.viewBox[2], bh: prepared.viewBox[3], x, y, scale: 0.25, rotation: 0 };
}

const glyphEl = (objId: string, index: number) => document.querySelector(`[data-mm-obj="${objId}"] [data-mm-glyph="${index}"]`) as SVGElement;
const rectOf = (el: Element) => el.getBoundingClientRect();
const unionOf = (els: Element[]) => {
  const rects = els.map(rectOf);
  const l = Math.min(...rects.map((r) => r.left));
  const t = Math.min(...rects.map((r) => r.top));
  const r = Math.max(...rects.map((r) => r.right));
  const b = Math.max(...rects.map((r) => r.bottom));
  return { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t };
};
const paintOf = (el: Element) => (el.matches('path') ? el : el.querySelector('path')!) as SVGElement;
const fillOf = (el: Element) => getComputedStyle(paintOf(el)).fill;

async function glyphTests() {
  const A = mkFormula('o1', '4x+5x=2', 960, 300);
  const B = mkFormula('o2', '9x=2', 960, 800);
  const { rt, fx } = mkStage(1);

  rt.setProject(mkProject([A, B]));
  const info = rt.getGlyphs('o1');
  check('glifos: un índice por carácter con su contenido', info.map((g) => g.char).join('') === '4x+5x=2' && info.every((g, i) => g.index === i && g.glyphId === `o1.g${i}`), JSON.stringify(info.map((g) => g.char)));
  check('glifos: caja local medida', info.every((g) => g.box.w > 0 && g.box.h > 0), JSON.stringify(info[0]));
  const c3 = centerOf(glyphEl('o1', 3));
  check('glifos: selección por clic (glyphAt)', rt.glyphAt('o1', c3.x, c3.y) === 3 && rt.glyphAt('o1', 5, 5) === null);

  // estilo propio de cada glifo
  const base = { x: centerOf(glyphEl('o1', 6)).x, w: rectOf(glyphEl('o1', 6)).width };
  const baseCenter = centerOf(glyphEl('o1', 6));
  const baseOpacity = getComputedStyle(glyphEl('o1', 0)).opacity;
  rt.setProject(mkProject([{ ...A, glyphStyles: { '1': { color: '#ff0000' }, '6': { scale: 2 }, '0': { opacity: 0.5 } } }, B]));
  check('glifos: color individual', fillOf(glyphEl('o1', 1)) === 'rgb(255, 0, 0)' && fillOf(glyphEl('o1', 0)) === 'rgb(248, 250, 252)', fillOf(glyphEl('o1', 1)));
  const scaled = centerOf(glyphEl('o1', 6));
  check('glifos: escala local sobre su propio centro (viewBox con desfase)', near(rectOf(glyphEl('o1', 6)).width, base.w * 2, 0.5) && near(scaled.x, baseCenter.x, 0.5) && near(scaled.y, baseCenter.y, 0.5), JSON.stringify([base, scaled, baseCenter]));
  check('glifos: opacidad individual', getComputedStyle(glyphEl('o1', 0)).opacity === '0.5' && baseOpacity === '1');
  rt.setProject(mkProject([A, B]));
  const restored = centerOf(glyphEl('o1', 6));
  check('glifos: quitar estilos restaura el estado base', near(restored.x, baseCenter.x, 0.01) && near(rectOf(glyphEl('o1', 6)).width, base.w, 0.01) && glyphEl('o1', 6).style.cssText === '', glyphEl('o1', 6).style.cssText);

  // Indicate sobre un subconjunto de glifos
  const group0 = unionOf([glyphEl('o1', 0), glyphEl('o1', 1)]);
  const ind = mkClip('c1', 'o1', 'indicate', 0, 1, { glyphs: '0,1', scale: 1.3, color: '#ffff00' });
  rt.setProject(mkProject([A, B], [ind]));
  rt.renderAt(0.5);
  const group1 = unionOf([glyphEl('o1', 0), glyphEl('o1', 1)]);
  check('Indicate: el término crece 1.3× alrededor de su centro', near(group1.w, group0.w * 1.3, 0.6) && near(group1.h, group0.h * 1.3, 0.6) && near(group1.x, group0.x, 0.6) && near(group1.y, group0.y, 0.6), JSON.stringify([group0, group1]));
  check('Indicate: brilla en amarillo solo en el término', fillOf(glyphEl('o1', 0)) === 'rgb(255, 255, 0)' && fillOf(glyphEl('o1', 4)) === 'rgb(248, 250, 252)', fillOf(glyphEl('o1', 0)));
  check('Indicate: el resto de la ecuación no se mueve', near(centerOf(glyphEl('o1', 6)).x, baseCenter.x, 0.01));
  rt.renderAt(1);
  const group2 = unionOf([glyphEl('o1', 0), glyphEl('o1', 1)]);
  check('Indicate: vuelve a su estado original', near(group2.w, group0.w, 0.01) && near(group2.x, group0.x, 0.01) && fillOf(glyphEl('o1', 0)) === 'rgb(248, 250, 252)');
  rt.renderAt(0.5);
  rt.renderAt(0);
  check('Indicate: retroceder deja los glifos sin estilos residuales', glyphEl('o1', 0).style.cssText === '' && paintOf(glyphEl('o1', 0)).style.cssText === '');

  // Término nombrado como alcance
  const named = { ...A, terms: [{ id: 't1', name: '4x', glyphs: [0, 1] }] };
  rt.setProject(mkProject([named, B], [mkClip('c1', 'o1', 'indicate', 0, 1, { term: 't1', scale: 1.5 })]));
  rt.renderAt(0.5);
  check('Indicate: un término con nombre resuelve sus glifos', near(unionOf([glyphEl('o1', 0), glyphEl('o1', 1)]).w, group0.w * 1.5, 0.8));
  rt.renderAt(0);

  // Circumscribe y FocusOn
  rt.setProject(mkProject([A, B], [mkClip('c1', 'o1', 'circumscribe', 0, 1, { glyphs: '0,1' }), mkClip('c2', 'o1', 'focus', 2, 1, { glyphs: '6' })]));
  rt.renderAt(0.5);
  const frame = fx.querySelector('rect');
  check('Circumscribe: marco luminoso sobre los glifos', !!frame && Number(frame.getAttribute('width')) > group0.w && frame.getAttribute('stroke') === '#ffff00', fx.innerHTML);
  rt.renderAt(1.5);
  check('Circumscribe: desaparece al terminar', fx.querySelectorAll('rect').length === 0);
  rt.renderAt(2.2);
  const r1 = Number(fx.querySelector('circle')?.getAttribute('r'));
  rt.renderAt(2.8);
  const r2 = Number(fx.querySelector('circle')?.getAttribute('r'));
  check('FocusOn: el foco se encoge hacia el glifo', r1 > r2 && r2 > 0, `${r1} ${r2}`);
  rt.renderAt(0);

  // Write con lag_ratio por glifo
  rt.setProject(mkProject([A], [mkClip('c1', 'o1', 'draw', 0, 1, { lagRatio: 1 })]));
  rt.renderAt(0.4);
  const first = paintOf(glyphEl('o1', 0));
  const last = paintOf(glyphEl('o1', 6));
  check('Write: lag_ratio escalona glifo por glifo', first.style.strokeDashoffset === '0px' || first.style.strokeDashoffset === '0' ? last.style.strokeOpacity === '0' : false, `${first.style.cssText} | ${last.style.cssText}`);
  rt.renderAt(0);

  // TransformMatchingTex
  const match = mkClip('c1', 'o1', 'transformMatch', 1, 1, { to: 'o2' });
  rt.setProject(mkProject([A, B], [match]));
  const wrapA = document.querySelector('[data-mm-obj="o1"]') as HTMLElement;
  const wrapB = document.querySelector('[data-mm-obj="o2"]') as HTMLElement;
  rt.renderAt(0.5);
  check('TransformMatchingTex: la ecuación destino no existe antes del clip', wrapB.style.opacity === '0' && wrapA.style.opacity === '1');
  const pairs = matchGlyphs([...'4x+5x=2'], [...'9x=2']);
  check('TransformMatchingTex: empareja x, = y 2', JSON.stringify(pairs) === '[[1,1],[5,2],[6,3]]', JSON.stringify(pairs));
  const startX = centerOf(glyphEl('o1', 1));
  const destX = centerOf(glyphEl('o2', 1));
  rt.renderAt(1.5);
  const midX = centerOf(glyphEl('o1', 1));
  check('TransformMatchingTex: el símbolo igual se desliza a medio camino', near(midX.x, (startX.x + destX.x) / 2, 1.5) && near(midX.y, (startX.y + destX.y) / 2, 1.5), JSON.stringify([startX, midX, destX]));
  check('TransformMatchingTex: términos que desaparecen se desvanecen y los nuevos aparecen', near(Number(getComputedStyle(glyphEl('o1', 0)).opacity), 0.5, 0.02) && near(Number(getComputedStyle(glyphEl('o2', 0)).opacity), 0.5, 0.02) && getComputedStyle(glyphEl('o2', 1)).opacity === '0', getComputedStyle(glyphEl('o1', 0)).opacity);
  rt.renderAt(1.999);
  const endX = centerOf(glyphEl('o1', 1));
  check('TransformMatchingTex: justo antes del final el símbolo coincide con el destino', near(endX.x, destX.x, 1) && near(endX.y, destX.y, 1), JSON.stringify([endX, destX]));
  rt.renderAt(2);
  check('TransformMatchingTex: al terminar A desaparece y B queda visible', wrapA.style.opacity === '0' && wrapB.style.opacity === '1' && getComputedStyle(glyphEl('o2', 1)).opacity === '1', JSON.stringify([wrapA.style.opacity, wrapB.style.opacity, getComputedStyle(glyphEl('o2', 1)).opacity]));
  rt.renderAt(0);
  check('TransformMatchingTex: retroceder al inicio restaura A', near(centerOf(glyphEl('o1', 1)).x, startX.x, 0.01) && glyphEl('o1', 1).style.cssText === '', `${centerOf(glyphEl('o1', 1)).x} vs ${startX.x} | ${glyphEl('o1', 1).style.cssText}`);

  // Transform hacia otro objeto (crossfade y pose)
  rt.setProject(mkProject([A, B], [mkClip('c1', 'o1', 'transform', 1, 1, { to: 'o2', replace: true })]));
  rt.renderAt(1.5);
  const midBox = rectOf(wrapA);
  rt.renderAt(0.5);
  check('Transform: destino oculto antes del clip', wrapB.style.opacity === '0');
  rt.renderAt(1.5);
  check('Transform: a medio clip A viaja hacia B con opacidades cruzadas', near(Number(wrapA.style.opacity), 0.5, 0.01) && near(Number(wrapB.style.opacity), 0.5, 0.01) && near(midBox.top + midBox.height / 2, 550, 2), `${wrapA.style.opacity} ${wrapB.style.opacity} ${midBox.top}`);
  rt.renderAt(2);
  check('Transform: al terminar queda solo el destino', wrapA.style.opacity === '0' && wrapB.style.opacity === '1');

  // Transform de un término a un término de otra ecuación
  const dest = { ...B, terms: [{ id: 't1', name: '9', glyphs: [0] }] };
  rt.setProject(mkProject([A, dest], [mkClip('c1', 'o1', 'transform', 1, 1, { glyphs: '0,1', to: 'o2', toTerm: 't1' })]));
  const nineBefore = getComputedStyle(glyphEl('o2', 0)).opacity;
  rt.renderAt(0.5);
  const hiddenNine = getComputedStyle(glyphEl('o2', 0)).opacity;
  const target = centerOf(glyphEl('o2', 0));
  rt.renderAt(2);
  const moved = unionOf([glyphEl('o1', 0), glyphEl('o1', 1)]);
  check('Transform de término: el origen llega al término destino', near(moved.x, target.x, 1.5) && near(moved.y, target.y, 1.5) && getComputedStyle(glyphEl('o1', 0)).opacity === '0' && getComputedStyle(glyphEl('o2', 0)).opacity === nineBefore && hiddenNine === '0', JSON.stringify([moved, target, hiddenNine]));
  rt.renderAt(0);

  // Transform hacia un estado (posición, escala, giro, color y opacidad)
  const two = unionOf([glyphEl('o1', 6)]);
  rt.setProject(mkProject([A], [mkClip('c1', 'o1', 'transform', 0, 1, { glyphs: '6', dx: 100, dy: 40, scale: 2, rotation: 90, opacity: 0.5, color: '#00ff00' })]));
  rt.renderAt(1);
  const twoEnd = unionOf([glyphEl('o1', 6)]);
  check('Transform de estado: posición y escala del término', near(twoEnd.x, two.x + 100, 1) && near(twoEnd.y, two.y + 40, 1) && near(twoEnd.h, two.w * 2, 1), JSON.stringify([two, twoEnd]));
  check('Transform de estado: color y opacidad destino', fillOf(glyphEl('o1', 6)) === 'rgb(0, 255, 0)' && near(Number(getComputedStyle(glyphEl('o1', 6)).opacity), 0.5, 0.01));
  rt.renderAt(0);

  // Desaparecer: FadeOut / ShrinkToCenter de objetos completos, glifos y re-entrada
  const opOf = (el: Element) => Number(getComputedStyle(el).opacity);
  const wrap1 = document.querySelector('[data-mm-obj="o1"]') as HTMLElement;
  rt.setProject(mkProject([A], [mkClip('c1', 'o1', 'disappear', 1, 1, { mode: 'fade' })]));
  rt.renderAt(0.5);
  const fadeBefore = opOf(glyphEl('o1', 0));
  rt.renderAt(1.5);
  const fadeMid = opOf(glyphEl('o1', 0));
  rt.renderAt(2.5);
  check('FadeOut: visible antes, a medias durante y oculto después', fadeBefore === 1 && near(fadeMid, 0.5, 0.02) && opOf(glyphEl('o1', 0)) === 0 && wrap1.style.pointerEvents === 'none',
    JSON.stringify([fadeBefore, fadeMid, opOf(glyphEl('o1', 0)), wrap1.style.pointerEvents]));
  const fullBox = unionOf(Array.from({ length: 7 }, (_, i) => glyphEl('o1', i)));
  rt.setProject(mkProject([A], [mkClip('c1', 'o1', 'disappear', 0, 1, { mode: 'shrink' })]));
  rt.renderAt(0);
  const shrinkStart = unionOf(Array.from({ length: 7 }, (_, i) => glyphEl('o1', i)));
  rt.renderAt(0.5);
  const shrinkMid = unionOf(Array.from({ length: 7 }, (_, i) => glyphEl('o1', i)));
  check('ShrinkToCenter: la ecuación se contrae hacia su centro', near(shrinkStart.w, fullBox.w, 0.5) && near(shrinkMid.w, fullBox.w / 2, 2)
    && near(shrinkMid.x, fullBox.x, 1.5) && near(shrinkMid.y, fullBox.y, 1.5) && near(opOf(glyphEl('o1', 3)), 0.5, 0.02), JSON.stringify([fullBox, shrinkMid]));
  rt.setProject(mkProject([A], [mkClip('c1', 'o1', 'disappear', 0, 1, { mode: 'fade', glyphs: '0-1' })]));
  rt.renderAt(2);
  check('FadeOut por glifo: solo el alcance desaparece', opOf(glyphEl('o1', 0)) === 0 && opOf(glyphEl('o1', 1)) === 0 && opOf(glyphEl('o1', 2)) === 1 && wrap1.style.pointerEvents === '');
  rt.setProject(mkProject([A], [
    mkClip('c1', 'o1', 'appear', 0, 1, { direction: 'none' }),
    mkClip('c2', 'o1', 'disappear', 2, 1, { mode: 'fade' }),
    mkClip('c3', 'o1', 'appear', 4, 1, { direction: 'none' }),
  ]));
  rt.renderAt(1.5);
  const reVisible = [wrap1.style.opacity, opOf(glyphEl('o1', 0))];
  rt.renderAt(3.5);
  const reHidden = opOf(glyphEl('o1', 0));
  rt.renderAt(4.5);
  const reMid = Number(wrap1.style.opacity) * opOf(glyphEl('o1', 0));
  rt.renderAt(6);
  check('Re-entrada: FadeIn posterior vuelve a mostrar el objeto tras la salida', reVisible[0] === '1' && reVisible[1] === 1 && reHidden === 0 && reMid > 0.2 && reMid < 1
    && wrap1.style.opacity === '1' && opOf(glyphEl('o1', 0)) === 1, JSON.stringify([reVisible, reHidden, reMid, wrap1.style.opacity, opOf(glyphEl('o1', 0))]));
  rt.renderAt(0);
  rt.dispose();

  // Desaparecer / Brotar sobre figuras SVG (objeto completo)
  {
    const { rt: rs } = mkStage(1);
    const sq = mkObj('o3', prepareSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>', 'o3').markup, 200, 200);
    const w3 = () => document.querySelector('[data-mm-obj="o3"]') as HTMLElement;
    rs.setProject(mkProject([sq], [mkClip('c1', 'o3', 'disappear', 1, 1, { mode: 'shrink' })]));
    rs.renderAt(0.5);
    const before = rectOf(w3());
    rs.renderAt(1.5);
    const mid = rectOf(w3());
    rs.renderAt(3);
    check('Contraer figura: escala a la mitad en el centro y oculta al final', near(mid.width, before.width / 2, 1) && near(mid.left + mid.width / 2, before.left + before.width / 2, 1)
      && near(Number(w3().style.opacity), 0, 1e-6), JSON.stringify([before.width, mid.width, w3().style.opacity]));
    rs.setProject(mkProject([sq], [mkClip('c1', 'o3', 'appear', 0, 1, { mode: 'pop', direction: 'up', distance: 120 })]));
    rs.renderAt(0.7);
    const pop = rectOf(w3());
    rs.renderAt(2);
    const popEnd = rectOf(w3());
    check('Brotar (Pop) de figura: crece desde su centro (1.2×) sin deslizarse', near(pop.width, popEnd.width * 1.2, 1.5) && near(pop.top + pop.height / 2, popEnd.top + popEnd.height / 2, 1)
      && w3().style.opacity === '1', JSON.stringify([pop, popEnd]));
    const lineSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 20"><line x1="0" y1="10" x2="200" y2="10" stroke="#0000ff" stroke-width="4"/></svg>';
    const textSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40"><text x="0" y="30" font-size="30" fill="#0000ff">Hola</text></svg>';
    const ln = mkObj('o4', prepareSvg(lineSvg, 'o4').markup, 200, 20);
    const tx = { ...mkObj('o5', prepareSvg(textSvg, 'o5').markup, 200, 40), y: 300 };
    rs.setProject(mkProject([ln, tx], [
      mkClip('c1', 'o4', 'indicate', 0, 1, { scale: 1.3, color: '#ff0000' }),
      mkClip('c2', 'o5', 'indicate', 0, 1, { scale: 1.3, color: '#ff0000' }),
    ]));
    rs.renderAt(0.5);
    const lineEl = document.querySelector('[data-mm-obj="o4"] line') as SVGElement;
    const textEl = document.querySelector('[data-mm-obj="o5"] text') as SVGElement;
    const midStroke = getComputedStyle(lineEl).stroke;
    const midFill = getComputedStyle(textEl).fill;
    rs.renderAt(1.5);
    check('Indicate en trazos y textos: pulso de color que vuelve al original', midStroke === 'rgb(255, 0, 0)' && midFill === 'rgb(255, 0, 0)'
      && getComputedStyle(lineEl).stroke === 'rgb(0, 0, 255)' && getComputedStyle(textEl).fill === 'rgb(0, 0, 255)', JSON.stringify([midStroke, midFill]));
    const plane = normalizePlane({ plots: [{ id: 'f1', expression: 'x', color: '#ffff00', width: 3, visible: true }],
      points: [{ id: 'pt1', x: 1, y: 1, color: '#ff0000', radius: 6, visible: true }] });
    const pSvg = planeSvg(plane);
    const pl = { ...mkObj('o6', prepareSvg(pSvg, 'o6').markup, plane.width, plane.height), sourceSvg: pSvg, plane };
    rs.setProject(mkProject([pl], [
      mkClip('c1', 'o6', 'disappear', 0, 1, { mode: 'fade', subElementId: 'plot:f1' }),
      mkClip('c2', 'o6', 'disappear', 0, 1, { mode: 'shrink', subElementId: 'point:pt1' }),
    ]));
    rs.renderAt(2);
    const plotG = document.querySelector('[data-mm-obj="o6"] [data-mm-sub="plot:f1"]') as SVGElement;
    const pointG = document.querySelector('[data-mm-obj="o6"] [data-mm-sub="point:pt1"]') as SVGElement;
    const wrap6 = document.querySelector('[data-mm-obj="o6"]') as HTMLElement;
    check('Salida de sub-elementos del plano: la gráfica y el punto se ocultan; el plano sigue visible',
      getComputedStyle(plotG).opacity === '0' && getComputedStyle(pointG).opacity === '0' && wrap6.style.opacity === '1',
      JSON.stringify([getComputedStyle(plotG).opacity, getComputedStyle(pointG).opacity, wrap6.style.opacity]));
    rs.dispose();
  }

  // Exportación a Manim
  const manim = generateManim(mkProject(
    [{ ...A, glyphStyles: { '0': { color: '#ff0000' }, '1': { color: '#ff0000' }, '6': { scale: 1.5 } }, terms: [{ id: 't1', name: '4x', glyphs: [0, 1] }] }, B],
    [mkClip('c1', 'o1', 'indicate', 0, 1, { term: 't1', glyphs: '0-1', scale: 1.3, color: '#ffff00' }),
      mkClip('c2', 'o1', 'indicate', 1, 1, { glyphs: '5' }),
      mkClip('c3', 'o1', 'transformMatch', 2, 1, { to: 'o2' }),
      mkClip('c4', 'o1', 'draw', 4, 1, { lagRatio: 0.2 })],
  )).script;
  check('Manim: MathTex con una parte por glifo', manim.includes('o1 = MathTex("4", "x", "+", "5", "x", "=", "2")'), manim.slice(0, 600));
  check('Manim: estilos por glifo como eq[a:b].set_color(...)', manim.includes('o1[0:2].set_color("#ff0000")') && manim.includes('o1[6].scale(1.5)'));
  check('Manim: término con nombre', manim.includes('o1_t1 = o1[0:2]  # término "4x"') && manim.includes('Indicate(o1_t1, scale_factor=1.3, color="#ffff00"'));
  check('Manim: Indicate sobre un único glifo', manim.includes('Indicate(o1[5],'));
  check('Manim: TransformMatchingTex(eq1, eq2)', manim.includes('TransformMatchingTex(o1, o2, run_time=1)') && manim.includes('"reveal": [o2]'));
  check('Manim: Write con lag_ratio', manim.includes('Write(o1, lag_ratio=0.2, run_time=1)'));
  const exits = generateManim({
    ...mkProject([A, B], [
      mkClip('c1', 'o1', 'draw', 0, 1), mkClip('c2', 'o1', 'disappear', 2, 1, { mode: 'fade' }),
      mkClip('c3', 'o2', 'disappear', 1, 0.5, { mode: 'shrink', glyphs: '0' }), mkClip('c4', 'o1', 'appear', 4, 1, { direction: 'none' }),
      mkClip('c5', 'o2', 'appear', 5, 1, { mode: 'pop' }),
    ]),
    savedGroups: [{ id: 'g1', name: 'Ecuaciones', objectIds: ['o1', 'o2'] }],
    sceneBackground: { type: 'grid-dots', bgColor: '#0b121c', lineColor: '#7c878e', opacity: 0.35, cellSize: 160, dotRadius: 2 },
  }).script;
  check('Manim: FadeOut del objeto', exits.includes('FadeOut(o1, run_time=1)') && exits.includes('"exit": True'));
  check('Manim: ShrinkToCenter de un glifo', exits.includes('ShrinkToCenter(o2[0], run_time=0.5)'));
  check('Manim: GrowFromCenter (Pop) de un objeto', exits.includes('GrowFromCenter(o2, run_time=1)'));
  check('Manim: grupos guardados como VGroup', exits.includes('group_g1 = VGroup(o1, o2)'));
  check('Manim: plantilla de fondo con retícula', exits.includes('config.background_color = "#0b121c"') && exits.includes('scene_grid'));
}
