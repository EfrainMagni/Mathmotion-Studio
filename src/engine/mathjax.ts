import { inlineUses, prepareSvg } from './svgImport';

export const loadMathJax = () => import('./mathjaxRenderer');

export interface FormulaSvg {
  /** SVG autocontenido (sin referencias a defs externas). */
  svgText: string;
}

/** Convierte LaTeX en un SVG autocontenido. Lanza un Error con el mensaje de sintaxis. */
export async function texToSvg(tex: string, color: string): Promise<FormulaSvg> {
  const { renderFormula } = await loadMathJax();
  let node: Element;
  try {
    node = await renderFormula(tex);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
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
export async function formulaToPrepared(tex: string, objId: string, color: string) {
  const { svgText } = await texToSvg(tex, color);
  return { ...prepareSvg(svgText, objId), sourceSvg: svgText };
}
