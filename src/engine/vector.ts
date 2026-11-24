import { fontStack, type VectorGeometry, type VectorTool, type Vertex } from '../types';

export const VECTOR_LABEL: Record<VectorTool, string> = {
  rectangle: 'Rectángulo', ellipse: 'Círculo / Elipse', line: 'Línea',
  arrow: 'Flecha vectorial', text: 'Texto libre', polygon: 'Polígono',
};

export const VECTOR_FILL = '#38bdf8';
export const VECTOR_STROKE = '#38bdf8';
export const VECTOR_STROKE_WIDTH = 4;

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

export function vectorSvg(vector: VectorGeometry, width: number, height: number) {
  const { tool, reverseX, reverseY, tip, text, textStyle } = vector;
  // Permite líneas horizontales/verticales y deja el trazo visible fuera del viewBox.
  const x1 = width <= 1 ? 0.5 : reverseX ? width : 0;
  const x2 = width <= 1 ? 0.5 : reverseX ? 0 : width;
  const y1 = height <= 1 ? 0.5 : reverseY ? height : 0;
  const y2 = height <= 1 ? 0.5 : reverseY ? 0 : height;
  const fill = `fill="${VECTOR_FILL}"`;
  const stroke = `stroke="${VECTOR_STROKE}" stroke-width="${VECTOR_STROKE_WIDTH}" stroke-linecap="round"`;
  const heads = tool === 'arrow' && tip !== 'none'
    ? `<defs><marker id="tip" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="strokeWidth" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10${tip === 'open' ? '' : 'Z'}" fill="${tip === 'open' ? 'none' : 'context-stroke'}" stroke="context-stroke" stroke-width="1"/></marker></defs>`
    : '';
  const markup = {
    polygon: `<polygon points="${vector.vertices?.map(({ x, y }) => `${x},${y}`).join(' ') ?? ''}" ${fill}/>`,
    rectangle: `<rect width="${width}" height="${height}" ${fill}/>`,
    ellipse: `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${fill}/>`,
    line: `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}/>`,
    arrow: `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}${heads ? ' marker-end="url(#tip)"' : ''}${tip === 'both' ? ' marker-start="url(#tip)"' : ''}/>`,
    text: textStyle
      ? `<text x="${textStyle.align === 'center' ? width / 2 : textStyle.align === 'right' ? width : 0}" y="${height * 0.8}" font-family="${fontStack(textStyle.fontFamily).replaceAll('"', '')}" font-size="${height}" font-weight="${textStyle.fontWeight}" font-style="${textStyle.italic ? 'italic' : 'normal'}" text-anchor="${textStyle.align === 'center' ? 'middle' : textStyle.align === 'right' ? 'end' : 'start'}" letter-spacing="${textStyle.letterSpacing}" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`
      : `<text x="0" y="${height * 0.8}" font-family="sans-serif" font-size="${height}" textLength="${width}" lengthAdjust="spacingAndGlyphs" xml:space="preserve" ${fill}>${xml(text ?? '')}</text>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${Math.max(1, width)} ${Math.max(1, height)}" overflow="visible">${heads}${markup[tool]}</svg>`;
}
