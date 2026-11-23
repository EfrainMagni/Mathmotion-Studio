import mathjaxUrl from 'mathjax-full/es5/tex-svg.js?url';
import { inlineUses, prepareSvg, type PreparedSvg } from './svgImport';

/* eslint-disable @typescript-eslint/no-explicit-any */
let loading: Promise<any> | null = null;

/** Carga MathJax v3 (salida SVG) una sola vez. Los glifos se incrustan (fontCache: 'none'). */
export function loadMathJax(): Promise<any> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const w = window as any;
    if (w.MathJax?.tex2svgPromise) {
      resolve(w.MathJax);
      return;
    }
    w.MathJax = {
      loader: { load: [] },
      tex: {
        packages: { '[+]': ['ams'] },
        // Lanza el error de sintaxis en lugar de dibujarlo dentro de la fórmula.
        formatError(_jax: unknown, err: Error) {
          throw err;
        },
      },
      svg: { fontCache: 'none' },
      startup: { typeset: false },
    };
    const s = document.createElement('script');
    s.src = mathjaxUrl;
    s.async = true;
    s.onload = () => {
      const mj = (window as any).MathJax;
      Promise.resolve(mj?.startup?.promise).then(() => resolve(mj), reject);
    };
    s.onerror = () => reject(new Error('No se pudo cargar MathJax.'));
    document.head.appendChild(s);
  });
  loading.catch(() => {
    loading = null; // permite reintentar
  });
  return loading;
}

export interface FormulaSvg {
  /** SVG autocontenido (sin referencias a defs externas). */
  svgText: string;
}

/** Convierte LaTeX en un SVG autocontenido. Lanza un Error con el mensaje de sintaxis. */
export async function texToSvg(tex: string, color: string): Promise<FormulaSvg> {
  const MathJax = await loadMathJax();
  let node: Element;
  try {
    node = await MathJax.tex2svgPromise(tex, { display: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.replace(/^TeX parse error:\s*/i, ''));
  }
  const svg = node.querySelector('svg');
  if (!svg) throw new Error('MathJax no generó un SVG.');
  inlineUses(svg);
  svg.removeAttribute('style');
  svg.removeAttribute('focusable');
  svg.removeAttribute('aria-hidden');
  svg.setAttribute('style', `color:${color}`);
  return { svgText: new XMLSerializer().serializeToString(svg) };
}

/** Prepara el SVG de una fórmula con la misma ruta de saneado que los SVG importados. */
export async function formulaToPrepared(tex: string, objId: string, color: string): Promise<PreparedSvg> {
  const { svgText } = await texToSvg(tex, color);
  return prepareSvg(svgText, objId);
}
