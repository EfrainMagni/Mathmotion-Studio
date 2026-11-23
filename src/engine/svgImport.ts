/**
 * Importación de SVG: saneado, aislamiento de ids y estilos, asignación de ids de nodo.
 * No depende de librerías externas (solo DOM), para poder probarse en un navegador real.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const ALLOWED = new Set([
  'svg', 'g', 'defs', 'path', 'line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'pattern', 'symbol', 'use', 'marker', 'image', 'filter', 'style',
]);

/** Elementos cuyo contenido no se dibuja directamente: no reciben id de nodo. */
const NON_RENDERED = new Set([
  'defs', 'clippath', 'mask', 'pattern', 'symbol', 'marker', 'lineargradient', 'radialgradient',
  'filter', 'style', 'stop', 'textpath', 'tspan',
]);

/** Elementos que se pueden seleccionar en el lienzo. */
export const SELECTABLE_SHAPES = new Set([
  'path', 'line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon', 'text',
]);

export interface PreparedSvg {
  markup: string;
  viewBox: [number, number, number, number];
  nodeCount: number;
  warnings: string[];
}

export class SvgImportError extends Error {}

export interface Ctx {
  prefix: string;
  idMap: Map<string, string>;
  counter: number;
  objId: string;
  removed: Map<string, number>;
  externalRefs: number;
}

function bump(ctx: Ctx, key: string) {
  ctx.removed.set(key, (ctx.removed.get(key) ?? 0) + 1);
}

function mapId(ctx: Ctx, id: string): string {
  return ctx.idMap.get(id) ?? ctx.prefix + id;
}

/** Reescribe url(#id) y descarta cualquier url() externa. Devuelve null si debe descartarse. */
function rewriteUrls(value: string, ctx: Ctx): string | null {
  let bad = false;
  const out = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, ref: string) => {
    const r = ref.trim();
    if (r.startsWith('#')) return `url(#${mapId(ctx, r.slice(1))})`;
    bad = true;
    return '';
  });
  if (bad) {
    ctx.externalRefs++;
    return null;
  }
  return out;
}

const BAD_CSS_PROP = /^(animation|transition|behavior|-moz-binding|-webkit-animation)/i;
const BAD_CSS_VALUE = /expression\(|javascript:|@import|-moz-binding|behavior\s*:/i;

function sanitizeDeclaration(prop: string, value: string, ctx: Ctx): string | null {
  if (BAD_CSS_PROP.test(prop) || BAD_CSS_VALUE.test(value)) return null;
  if (/url\(/i.test(value)) return rewriteUrls(value, ctx);
  return value;
}

function sanitizeInlineStyle(css: string, ctx: Ctx): string {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of css) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!prop) continue;
    const v = sanitizeDeclaration(prop, value, ctx);
    if (v !== null) out.push(`${prop}:${v}`);
  }
  return out.join(';');
}

function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function scopeSelector(sel: string, scope: string, ctx: Ctx): string {
  let s = sel.replace(/#([A-Za-z_][\w-]*)/g, (_m, id: string) => '#' + mapId(ctx, id));
  if (/^:root(?![\w-])/.test(s)) return scope + s.replace(/^:root/, '');
  if (/^svg(?=[\s.:#[>+~]|$)/i.test(s)) return scope + s.replace(/^svg/i, '');
  if (/^(\*|html|body)$/i.test(s)) return `${scope}, ${scope} *`;
  return `${scope} ${s}`;
}

/** Reescribe una hoja de estilos para que solo afecte al interior de `scope`. */
export function scopeCss(css: string, scope: string, ctx: Ctx): string {
  if (typeof CSSStyleSheet === 'undefined') return '';
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css.replace(/@import[^;]*;/gi, ''));
  } catch {
    return '';
  }
  const handle = (rule: CSSRule): string | null => {
    if (rule instanceof CSSStyleRule) {
      const decls: string[] = [];
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        const v = sanitizeDeclaration(prop, rule.style.getPropertyValue(prop), ctx);
        if (v !== null) {
          const imp = rule.style.getPropertyPriority(prop) ? ' !important' : '';
          decls.push(`${prop}:${v}${imp}`);
        }
      }
      if (!decls.length) return null;
      const sels = splitSelectors(rule.selectorText).map((s) => scopeSelector(s, scope, ctx));
      return `${sels.join(',')}{${decls.join(';')}}`;
    }
    if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner = Array.from(rule.cssRules).map(handle).filter((x): x is string => !!x).join('');
      if (!inner) return null;
      const head = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
      return `${head}{${inner}}`;
    }
    return null; // @font-face, @keyframes, @import, @namespace…: descartados
  };
  return Array.from(sheet.cssRules).map(handle).filter((x): x is string => !!x).join('\n');
}

function parseLength(v: string | null): number | null {
  if (!v) return null;
  const m = v.trim().match(/^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const f: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  return n * f[unit];
}

function parseViewBox(v: string | null): [number, number, number, number] | null {
  if (!v) return null;
  const n = v.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return null;
  return [n[0], n[1], n[2], n[3]];
}

/** Convierte `<switch>` y `<a>` en grupos simples (los elementos externos se descartan después). */
function normalizeStructure(svg: Element) {
  let sw: Element | null;
  while ((sw = svg.querySelector('switch'))) {
    const parent = sw.parentNode!;
    for (const child of Array.from(sw.children)) {
      if (child.localName.toLowerCase() !== 'foreignobject') parent.insertBefore(child, sw);
    }
    parent.removeChild(sw);
  }
  let a: Element | null;
  while ((a = svg.querySelector('a'))) {
    const g = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    for (const attr of Array.from(a.attributes)) {
      if (attr.localName !== 'href' && attr.localName !== 'target' && attr.localName !== 'rel') {
        try {
          g.setAttributeNode(attr.cloneNode() as Attr);
        } catch {
          /* ignorar */
        }
      }
    }
    while (a.firstChild) g.appendChild(a.firstChild);
    a.parentNode!.replaceChild(g, a);
  }
}

function cleanElement(el: Element, ctx: Ctx, insideNonRendered: boolean) {
  for (const child of Array.from(el.children)) {
    const name = child.localName.toLowerCase();
    const allowed =
      child.namespaceURI === SVG_NS && (ALLOWED.has(name) || /^fe[a-z]+$/.test(name));
    if (!allowed) {
      bump(ctx, name);
      el.removeChild(child);
      continue;
    }
    if (!sanitizeAttributes(child, name, ctx)) {
      bump(ctx, name);
      el.removeChild(child);
      continue;
    }
    if (name === 'style') {
      // se procesa aparte (necesita el mapa de ids completo y el ámbito)
    }
    const nonRendered = insideNonRendered || NON_RENDERED.has(name);
    if (!nonRendered && (SELECTABLE_SHAPES.has(name) || name === 'g' || name === 'image' || name === 'use')) {
      const n = ++ctx.counter;
      const orig = child.getAttribute('data-mm-orig-id') ?? '';
      child.setAttribute('data-mm-id', `${ctx.objId}.${n}`);
      const label = orig || child.getAttribute('data-name') || `${name} ${n}`;
      child.setAttribute('data-mm-name', label);
      child.removeAttribute('data-mm-orig-id');
    }
    cleanElement(child, ctx, nonRendered);
  }
}

/** Devuelve false si el elemento debe eliminarse. */
function sanitizeAttributes(el: Element, name: string, ctx: Ctx): boolean {
  for (const attr of Array.from(el.attributes)) {
    const aname = attr.name;
    const lname = aname.toLowerCase();
    const value = attr.value;

    if (lname.startsWith('on')) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (attr.namespaceURI === XMLNS_NS) {
      if (attr.localName !== 'xlink' && aname !== 'xmlns') el.removeAttributeNode(attr);
      continue;
    }
    if (attr.namespaceURI && attr.namespaceURI !== XLINK_NS && attr.namespaceURI !== XML_NS) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (lname === 'href' || lname === 'xlink:href') {
      const v = value.trim();
      if (v.startsWith('#')) {
        el.setAttributeNS(attr.namespaceURI, aname, '#' + mapId(ctx, v.slice(1)));
      } else if (name === 'image' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) {
        /* imagen incrustada: se conserva */
      } else {
        ctx.externalRefs++;
        el.removeAttributeNode(attr);
      }
      continue;
    }
    if (lname === 'id') {
      el.setAttribute('data-mm-orig-id', value);
      el.setAttribute('id', mapId(ctx, value));
      continue;
    }
    if (lname === 'style') {
      const s = sanitizeInlineStyle(value, ctx);
      if (s) el.setAttribute('style', s);
      else el.removeAttribute('style');
      continue;
    }
    if (/javascript:|data:text\/html/i.test(value)) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (/url\(/i.test(value)) {
      const v = rewriteUrls(value, ctx);
      if (v === null) el.removeAttributeNode(attr);
      else el.setAttribute(aname, v);
    }
  }
  if (name === 'use') {
    const h = el.getAttribute('href') ?? el.getAttribute('xlink:href');
    if (!h || !h.startsWith('#')) return false;
  }
  return true;
}

function collectIds(svg: Element, ctx: Ctx) {
  svg.querySelectorAll('[id]').forEach((el) => {
    const id = el.getAttribute('id')!;
    if (!ctx.idMap.has(id)) ctx.idMap.set(id, ctx.prefix + id);
  });
}

function measureBBox(svg: SVGSVGElement): [number, number, number, number] | null {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none';
  holder.appendChild(svg);
  document.body.appendChild(holder);
  try {
    const b = svg.getBBox();
    if (b.width > 0 && b.height > 0) return [b.x, b.y, b.width, b.height];
    return null;
  } catch {
    return null;
  } finally {
    holder.remove();
  }
}

/**
 * Sanea un SVG y lo deja listo para montarse de forma independiente.
 * `objId` es el id del objeto: se usa como prefijo de ids y como ámbito de estilos.
 */
export function prepareSvg(text: string, objId: string): PreparedSvg {
  if (text.length > 25_000_000) throw new SvgImportError('El archivo SVG es demasiado grande (máx. 25 MB).');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const perr = doc.querySelector('parsererror');
  if (perr) {
    const msg = (perr.textContent ?? '').split('\n').find((l) => l.trim()) ?? 'XML mal formado';
    throw new SvgImportError(`SVG no válido: ${msg.trim().slice(0, 200)}`);
  }
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new SvgImportError('El archivo no contiene un elemento <svg> raíz.');
  }

  const ctx: Ctx = {
    prefix: `${objId}__`,
    idMap: new Map(),
    counter: 0,
    objId,
    removed: new Map(),
    externalRefs: 0,
  };

  // Comentarios fuera.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  normalizeStructure(root);
  collectIds(root, ctx);

  // La raíz también pasa por el saneado de atributos.
  sanitizeAttributes(root, 'svg', ctx);
  root.removeAttribute('data-mm-orig-id');
  cleanElement(root, ctx, false);

  // Estilos: se reescriben con ámbito. Se hace al final, con el mapa de ids completo.
  const scope = `[data-mm-scope="${objId}"]`;
  root.querySelectorAll('style').forEach((st) => {
    const css = scopeCss(st.textContent ?? '', scope, ctx);
    if (css) st.textContent = css;
    else st.parentNode?.removeChild(st);
  });

  // viewBox: se conserva; si falta, se deriva de width/height o del contenido.
  let vb = parseViewBox(root.getAttribute('viewBox'));
  let derived = false;
  if (!vb) {
    const w = parseLength(root.getAttribute('width'));
    const h = parseLength(root.getAttribute('height'));
    if (w && h) vb = [0, 0, w, h];
    derived = true;
  }
  root.setAttribute('data-mm-scope', objId);
  root.removeAttribute('width');
  root.removeAttribute('height');
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  if (vb && derived) root.setAttribute('viewBox', vb.join(' '));
  if (!vb) {
    const imported = document.importNode(root, true) as unknown as SVGSVGElement;
    const bb = measureBBox(imported);
    if (!bb) throw new SvgImportError('El SVG no tiene viewBox ni dimensiones y no contiene geometría visible.');
    vb = bb;
    root.setAttribute('viewBox', vb.join(' '));
  }

  const warnings: string[] = [];
  const removed = Array.from(ctx.removed.entries()).filter(([k]) => k !== 'style');
  if (removed.length) {
    const total = removed.reduce((a, [, n]) => a + n, 0);
    warnings.push(`Se eliminaron ${total} elementos no admitidos (${removed.map(([k, n]) => `${k}×${n}`).join(', ')}).`);
  }
  if (ctx.externalRefs) warnings.push(`Se bloquearon ${ctx.externalRefs} referencias a recursos externos.`);

  return {
    markup: new XMLSerializer().serializeToString(root),
    viewBox: vb,
    nodeCount: ctx.counter,
    warnings,
  };
}

/**
 * Sustituye `<use>` que apuntan a definiciones internas por copias en línea
 * (útil para glifos de MathJax con caché de fuentes). Conserva posición y relleno.
 */
export function inlineUses(svg: Element) {
  const doc = svg.ownerDocument;
  let guard = 0;
  let use: Element | null;
  while ((use = svg.querySelector('use')) && guard++ < 5000) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    const target = href.startsWith('#') ? svg.querySelector(`[id="${CSS.escape(href.slice(1))}"]`) : null;
    if (!target) {
      use.parentNode!.removeChild(use);
      continue;
    }
    const g = doc.createElementNS(SVG_NS, 'g');
    for (const a of Array.from(use.attributes)) {
      if (!['href', 'x', 'y', 'width', 'height', 'transform'].includes(a.localName)) {
        try {
          g.setAttributeNS(a.namespaceURI, a.name, a.value);
        } catch {
          /* ignorar */
        }
      }
    }
    g.removeAttribute('xlink:href');
    const x = use.getAttribute('x') ?? '0';
    const y = use.getAttribute('y') ?? '0';
    const t = use.getAttribute('transform') ?? '';
    const tr = `${t} translate(${x} ${y})`.trim();
    if (tr !== 'translate(0 0)') g.setAttribute('transform', tr);
    const clone = target.cloneNode(true) as Element;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    g.appendChild(clone);
    use.parentNode!.replaceChild(g, use);
  }
  // Las definiciones de glifos ya no hacen falta si nadie las referencia.
  svg.querySelectorAll('defs').forEach((d) => {
    if (!d.querySelector('linearGradient,radialGradient,clipPath,mask,pattern,filter,marker,style')) d.remove();
  });
}

/** SVG de ejemplo: grupos anidados, transformaciones, estilos de clase, gradiente y recorte internos. */
export const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 500" width="800" height="500">
  <defs>
    <style>
      .side { fill: none; stroke: #38bdf8; stroke-width: 6; stroke-linecap: round; }
      .vertex { fill: url(#vertexGrad); stroke: #f8fafc; stroke-width: 2; }
      .label { font-family: Georgia, serif; font-size: 34px; fill: #f8fafc; }
      .soft { opacity: .85; }
    </style>
    <radialGradient id="vertexGrad" cx="50%" cy="50%" r="60%">
      <stop offset="0" stop-color="#fde047"/>
      <stop offset="1" stop-color="#f97316"/>
    </radialGradient>
    <clipPath id="frameClip"><rect x="20" y="20" width="760" height="460" rx="24"/></clipPath>
  </defs>
  <g id="Marco" clip-path="url(#frameClip)">
    <rect id="Fondo" x="20" y="20" width="760" height="460" fill="#16233f"/>
    <g id="Triangulo" transform="translate(120 400) scale(1.1)" class="soft">
      <g id="Lados">
        <line id="Lado_a" class="side" x1="0" y1="0" x2="520" y2="0"/>
        <line id="Lado_b" class="side" x1="520" y1="0" x2="520" y2="-280" style="stroke:#a78bfa"/>
        <path id="Hipotenusa" class="side" d="M0 0 L520 -280" style="stroke:#34d399"/>
      </g>
      <g id="Vertices">
        <circle id="Vertice_A" class="vertex" cx="0" cy="0" r="12"/>
        <circle id="Vertice_B" class="vertex" cx="520" cy="0" r="12"/>
        <circle id="Vertice_C" class="vertex" cx="520" cy="-280" r="12"/>
      </g>
      <g id="Etiquetas" transform="translate(0 -18)">
        <text id="Texto_a" class="label" x="240" y="62">a</text>
        <text id="Texto_b" class="label" x="540" y="-120">b</text>
        <text id="Texto_c" class="label" x="230" y="-140">c</text>
      </g>
    </g>
  </g>
</svg>`;
