import type { NodeStyle, Vertex } from '../types';

const SVG_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const PATH_TOKEN = /[a-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const PATH_ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

type PathSegment = { command: string; values: number[]; start: number; end: number };

function parsePath(path: string) {
  const tokens = path.match(PATH_TOKEN) ?? [];
  if (path.replace(PATH_TOKEN, '').replace(/[\s,]/g, '')) return null;
  const points: Vertex[] = [];
  const segments: PathSegment[] = [];
  let command = '';
  let current = -1;
  let subpath = -1;
  for (let i = 0; i < tokens.length;) {
    if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
    const op = command.toUpperCase();
    if (!points.length && op !== 'M') return null;
    if (op === 'Z') {
      segments.push({ command: 'Z', values: [], start: current, end: subpath });
      current = subpath;
      command = '';
      continue;
    }
    const arity = PATH_ARITY[op];
    if (!arity) return null;
    const values: number[] = [];
    for (let j = 0; j < arity; j++) {
      const token = tokens[i];
      if (op === 'A' && (j === 3 || j === 4)) {
        // Las banderas de los arcos pueden ir pegadas entre sí y a la siguiente coordenada.
        if (!token || !/^[01]/.test(token)) return null;
        values.push(Number(token[0]));
        if (token.length > 1) tokens[i] = token.slice(1);
        else i++;
      } else {
        const value = Number(token);
        if (!Number.isFinite(value)) return null;
        values.push(value);
        i++;
      }
    }
    const pen = points[current] ?? { x: 0, y: 0 };
    const origin = command === op ? { x: 0, y: 0 } : pen;

    if (op === 'H') values.splice(0, 1, values[0] + origin.x, pen.y);
    else if (op === 'V') values.splice(0, 1, pen.x, values[0] + origin.y);
    else {
      for (let j = op === 'A' ? 5 : 0; j < values.length; j += 2) {
        values[j] += origin.x;
        values[j + 1] += origin.y;
      }
    }

    const end = points.length;
    points.push({ x: values.at(-2)!, y: values.at(-1)! });
    segments.push({ command: op === 'H' || op === 'V' ? 'L' : op, values, start: current, end });
    current = end;
    if (op === 'M') {
      subpath = end;
      command = command === op ? 'L' : 'l';
    }
  }
  return points.length >= 2 ? { points, segments } : null;
}

function editedPath(path: NonNullable<ReturnType<typeof parsePath>>, points: Vertex[]) {
  return path.segments.map(({ command, values, start, end }) => {
    if (command === 'Z') return 'Z';
    const output = [...values];
    const endpoint = points[end];
    const adjust = (index: number, original: Vertex, next: Vertex) => {
      output[index] += next.x - original.x;
      output[index + 1] += next.y - original.y;
    };
    // Las tangentes Bézier acompañan al ancla a la que pertenecen.
    if (command === 'C') {
      adjust(0, path.points[start], points[start]);
      adjust(2, path.points[end], endpoint);
    } else if (command === 'S') {
      adjust(0, path.points[end], endpoint);
    } else if (command === 'Q') {
      const midpoint = (a: Vertex, b: Vertex) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      adjust(0, midpoint(path.points[start], path.points[end]), midpoint(points[start], endpoint));
    }
    output.splice(-2, 2, endpoint.x, endpoint.y);
    return `${command} ${output.join(' ')}`;
  }).join(' ');
}

/** Lee anclas de contornos SVG en su sistema de coordenadas local. */
export function vertexGeometry(element: Element): Vertex[] | null {
  switch (element.localName) {
    case 'polygon':
    case 'polyline': {
      const coords = (element.getAttribute('points')?.match(SVG_NUMBER) ?? []).map(Number);
      if (coords.length < (element.localName === 'polygon' ? 6 : 4) || coords.length % 2 || !coords.every(Number.isFinite)) return null;
      return coords.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: coords[i * 2 + 1] }));
    }
    case 'line': {
      const coordinate = (name: string) => Number(element.getAttribute(name) ?? 0);
      const points = [{ x: coordinate('x1'), y: coordinate('y1') }, { x: coordinate('x2'), y: coordinate('y2') }];
      return points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)) ? points : null;
    }
    case 'path':
      return parsePath(element.getAttribute('d') ?? '')?.points ?? null;
    default:
      return null;
  }
}

export function vertexAttributes(element: Element, points: Vertex[]): Record<string, string> | null {
  if (element.localName === 'path') {
    const path = parsePath(element.getAttribute('d') ?? '');
    return path?.points.length === points.length ? { d: editedPath(path, points) } : null;
  }
  if (vertexGeometry(element)?.length !== points.length) return null;
  if (element.localName === 'line') {
    return { x1: String(points[0].x), y1: String(points[0].y), x2: String(points[1].x), y2: String(points[1].y) };
  }
  return { points: points.map(({ x, y }) => `${x},${y}`).join(' ') };
}

/** Aplica las ediciones por ID sobre el SVG ya preparado para la exportación. */
export function svgWithVertices(markup: string, objectId: string, styles: Record<string, NodeStyle>) {
  const overrides = Object.entries(styles).flatMap(([id, style]) =>
    id.startsWith(objectId + '.') && style.vertices ? [{ id, points: style.vertices }] : []);
  if (!overrides.length) return markup;
  const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  for (const { id, points } of overrides) {
    const element = root.querySelector(`[data-mm-id="${id}"]`);
    if (!element) continue;
    const attributes = vertexAttributes(element, points);
    if (attributes) {
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    }
  }
  return new XMLSerializer().serializeToString(root);
}
