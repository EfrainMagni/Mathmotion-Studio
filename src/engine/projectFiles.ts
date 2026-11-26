import { z } from 'zod';
import { SCENE_BG_LIMITS, type Obj2D, type Project } from '../types';
import { prepareSvg } from './svgImport';
import { normalizePlane, planeSvg } from './cartesianPlane';

const number = z.number();
const lineTip = z.enum(['none', 'stealth', 'right', 'triangle', 'open', 'circle']);
const vertex = z.object({ x: number, y: number });
const positive = number.positive();
const nonnegative = number.nonnegative();
const objectId = z.string().regex(/^o[1-9]\d*$/);
const targetId = z.string().regex(/^o[1-9]\d*(\.[1-9]\d*)?$/);
const clipId = z.string().regex(/^c[1-9]\d*$/);
const paint = z.string().refine((value) =>
  /^(none|currentColor|transparent|#[\da-f]{3,8}|rgba?\([\d\s.,%/+-]+\)|hsla?\([\d\s.,%/+-]+\))$/i.test(value));
const glyphStyle = z.object({ color: paint.optional(), scale: positive.optional(), opacity: number.min(0).max(1).optional() });
const term = z.object({
  id: z.string().regex(/^t[1-9]\d*$/), name: z.string().max(60), glyphs: z.array(z.int().nonnegative()).max(2000),
});
const hex = z.string().regex(/^#[\da-f]{3,8}$/i);
const planeItemId = z.string().regex(/^[a-z]{1,3}\d{1,6}$/);
const planePlot = z.object({
  id: planeItemId, expression: z.string().max(200), color: hex, width: positive,
  xStart: number.optional(), xEnd: number.optional(), visible: z.boolean(),
});
const planePoint = z.object({
  id: planeItemId, x: number, y: number, color: hex, radius: positive,
  label: z.string().max(24).optional(), showGuideLines: z.boolean().optional(), visible: z.boolean(),
});
/** Plano cartesiano: todos los campos son opcionales; `normalizePlane` completa y sanea al abrir. */
const plane = z.object({
  width: positive, height: positive,
  xMin: number, xMax: number, xStep: positive, yMin: number, yMax: number, yStep: positive,
  subdivisions: z.int().min(1).max(10),
  showAxes: z.boolean(), axisColor: hex, axisWidth: nonnegative, arrowTips: z.enum(['both', 'positive', 'none']),
  showAxisLabels: z.boolean(), xLabel: z.string().max(12), yLabel: z.string().max(12),
  showGrid: z.boolean(), gridColor: hex, gridOpacity: number.min(0).max(1), gridWidth: nonnegative,
  showSubGrid: z.boolean(), subGridColor: hex, subGridOpacity: number.min(0).max(1), subGridWidth: nonnegative,
  showTicks: z.boolean(), tickLength: nonnegative, showNumbers: z.boolean(), numberColor: hex,
  numberSize: positive, showOriginZero: z.boolean(),
  plots: z.array(planePlot).max(50), points: z.array(planePoint).max(200),
}).partial();
const baseObject = { id: objectId, name: z.string(), scale: positive, rotation: number };
const object2D = z.object({
  ...baseObject, kind: z.enum(['svg', 'formula']), sourceSvg: z.string(),
  vector: z.object({
    tool: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'text', 'polygon', 'pen', 'curve']),
    reverseX: z.boolean().optional(), reverseY: z.boolean().optional(),
    tip: z.enum(['triangle', 'open', 'both', 'none']).optional(), text: z.string().optional(),
    startTip: lineTip.optional(), endTip: lineTip.optional(),
    tipScale: number.min(0.5).max(3).optional(), endpoints: z.tuple([vertex, vertex]).optional(),
    textStyle: z.object({
      fontFamily: z.enum(['Inter', 'Space Grotesk', 'Lora', 'Playfair Display', 'Great Vibes', 'Dancing Script']),
      fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), italic: z.boolean(),
      align: z.enum(['left', 'center', 'right']), letterSpacing: z.number().min(-50).max(200),
    }).optional(),
    vertices: z.array(vertex).min(3).max(20).optional(),
    // Trazados Bézier (pluma / curva suavizada): nodos con tipo y manejadores opcionales.
    nodes: z.array(z.object({
      x: number, y: number, type: z.enum(['corner', 'smooth']), in: vertex.optional(), out: vertex.optional(),
    })).min(2).max(4096).optional(),
    closed: z.boolean().optional(),
  }).refine((vector) => vector.tool !== 'polygon' || !!vector.vertices)
    .refine((vector) => (vector.tool !== 'pen' && vector.tool !== 'curve') || !!vector.nodes).optional(),
  plane: plane.optional(),
  x: number, y: number, bw: positive, bh: positive, tex: z.string().optional(),
  glyphStyles: z.record(z.string().regex(/^\d+$/), glyphStyle).optional(), terms: z.array(term).optional(),
});
/** Compatibilidad: los archivos antiguos pueden traer objetos 3D; se leen solo para descartarlos. */
const legacyObject3D = z.object({ id: objectId, kind: z.literal('shape3d') });
const gradientStop = z.object({ id: z.string().min(1).max(40), offset: number.min(0).max(100), color: paint });
const fillGradient = z.object({
  mode: z.enum(['solid', 'linear', 'radial']), angle: number.min(0).max(360),
  stops: z.array(gradientStop).min(2).max(16),
});
const style = z.object({
  fill: paint.optional(), fillGradient: fillGradient.optional(), stroke: paint.optional(), strokeWidth: nonnegative.optional(),
  lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  dashGap: positive.optional(), lineCap: z.enum(['butt', 'round']).optional(),
  lineJoin: z.enum(['miter', 'round']).optional(), fillOpacity: number.min(0).max(1).optional(),
  opacity: number.min(0).max(1).optional(),
  vertices: z.array(vertex).min(2).max(2048).optional(),
  scale: positive.optional(), tx: number.optional(), ty: number.optional(),
});
const parameters = z.record(z.string(), z.union([number, z.string(), z.boolean()])).superRefine((input, ctx) => {
  if (
    (input.color !== undefined && !paint.safeParse(input.color).success) ||
    (input.axis !== undefined && input.axis !== 'x' && input.axis !== 'y' && input.axis !== 'z') ||
    (input.to !== undefined && !objectId.safeParse(input.to).success) ||
    (input.term !== undefined && !/^t[1-9]\d*$/.test(String(input.term))) ||
    (input.toTerm !== undefined && !/^t[1-9]\d*$/.test(String(input.toTerm))) ||
    (input.glyphs !== undefined && !/^[\d,\s-]*$/.test(String(input.glyphs))) ||
    (input.subElementId !== undefined && !/^(plot|point):[a-z]{1,3}\d{1,6}$/.test(String(input.subElementId)))
  ) ctx.addIssue({ code: 'custom', message: 'Parámetros de animación no válidos.' });
});
const voice = z.object({
  name: z.string(), start: nonnegative, duration: positive, volume: number.min(0).max(1.5),
});
const voiceFile = voice.extend({ mime: z.string(), base64: z.base64() });
const project = z.object({
  format: z.enum(['9:16', '16:9']),
  background: z.enum(['board', 'grid', 'light']),
  // Plantilla de fondo (opcional: los archivos antiguos no la tienen y usan `background`).
  sceneBackground: z.object({
    type: z.enum(['solid', 'grid-dots', 'isometric-dots']),
    bgColor: hex,
    lineColor: hex,
    opacity: number.min(SCENE_BG_LIMITS.opacity.min).max(SCENE_BG_LIMITS.opacity.max),
    cellSize: number.min(SCENE_BG_LIMITS.cellSize.min).max(SCENE_BG_LIMITS.cellSize.max),
    dotRadius: number.min(SCENE_BG_LIMITS.dotRadius.min).max(SCENE_BG_LIMITS.dotRadius.max),
  }).optional(),
  objects: z.array(z.union([object2D, legacyObject3D])),
  styles: z.record(targetId, style),
  clips: z.array(z.object({
    id: clipId, targetId, type: z.enum([
      'draw', 'radar', 'glow', 'appear', 'rotate', 'orbit', // 'orbit' es legado 3D: se descarta al abrir
      'indicate', 'circumscribe', 'focus', 'transform', 'transformMatch',
    ]),
    start: nonnegative, duration: positive, sound: z.enum(['chalk', 'pop', 'radar', 'sparkle']).nullable(),
    parameters,
  })),
  // `camera` (3D) de archivos antiguos se ignora: zod descarta las claves desconocidas.
  counters: z.object({ obj: z.int().nonnegative(), clip: z.int().nonnegative() }),
});
const projectFile = z.object({
  version: z.literal(1),
  project: project.extend({ voice: voiceFile.nullable() }),
});

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(blob);
  });
}

export async function serializeProject(p: Project): Promise<string> {
  const objects = p.objects.map(({ markup, ...rest }) => rest);
  let track: z.infer<typeof voiceFile> | null = null;
  if (p.voice) {
    const { source, ...metadata } = p.voice;
    track = { ...metadata, mime: source.type, base64: await toBase64(source) };
  }
  return JSON.stringify({ version: 1, project: { ...p, objects, voice: track } });
}

export function parseProject(text: string): Project {
  const result = projectFile.safeParse(JSON.parse(text));
  if (!result.success) throw new Error('El archivo no es un proyecto MathMotion válido de la versión 1.');
  const data = result.data.project;
  // Proyecto 100% 2D: se ignoran objetos 3D, clips de cámara y todo lo que dependa de ellos.
  const dropped = new Set(data.objects.filter((object) => object.kind === 'shape3d').map((object) => object.id));
  const owner = (id: string) => id.split('.')[0];
  const p = {
    ...data,
    styles: Object.fromEntries(Object.entries(data.styles).filter(([id]) => !dropped.has(owner(id)))),
    clips: data.clips.filter((clip) =>
      clip.type !== 'orbit' && !dropped.has(owner(clip.targetId)) && !dropped.has(String(clip.parameters.to ?? ''))),
  };
  const objects = data.objects.flatMap((object): Obj2D[] => {
    if (object.kind === 'shape3d') return [];
    if (object.plane) {
      // El SVG de un plano se regenera siempre desde su geometría (saneada).
      const plane = normalizePlane(object.plane);
      const sourceSvg = planeSvg(plane);
      return [{ ...object, plane, sourceSvg, bw: plane.width, bh: plane.height, markup: prepareSvg(sourceSvg, object.id).markup }];
    }
    // El archivo nunca se monta directamente. Se reconstruyen los mismos IDs de nodo.
    const { markup } = prepareSvg(object.sourceSvg, object.id);
    return [{ ...object, plane: undefined, markup }];
  });
  const targets = new Set(objects.map((object) => object.id));
  const clipIds = new Set(p.clips.map((clip) => clip.id));
  if (
    targets.size !== objects.length || clipIds.size !== p.clips.length ||
    objects.some(({ id }) => Number(id.slice(1)) > p.counters.obj) ||
    p.clips.some(({ id }) => Number(id.slice(1)) > p.counters.clip) ||
    [...Object.keys(p.styles), ...p.clips.map((clip) => clip.targetId)]
      .some((id) => !targets.has(id.split('.')[0]))
  ) throw new Error('El archivo contiene identificadores de escena inconsistentes.');

  let track: Project['voice'] = null;
  if (p.voice) {
    const { base64, mime, ...metadata } = p.voice;
    const bytes = Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
    track = { ...metadata, source: new Blob([bytes], { type: mime }) };
  }
  return { ...p, clips: p.clips as Project['clips'], objects, voice: track };
}
