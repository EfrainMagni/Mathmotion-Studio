import { z } from 'zod';
import {
  FOCUS_LIMITS, FOCUS_TARGETS_RE, FONT_IDS, INDICATE_STROKE_LIMITS, SAVED_GROUP_NAME_MAX, SCENE_BG_LIMITS, SFX_VOLUME_MAX, SOUND_IDS, parseFocusTargets, parseObjectIds, pruneFocusClips, pruneGroupClips,
  pruneSavedGroups, type Obj2D, type Project,
} from '../types';
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
    tool: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'text', 'polygon', 'pen', 'curve', 'arc']),
    reverseX: z.boolean().optional(), reverseY: z.boolean().optional(),
    tip: z.enum(['triangle', 'open', 'both', 'none']).optional(), text: z.string().optional(),
    startTip: lineTip.optional(), endTip: lineTip.optional(),
    tipScale: number.min(0.5).max(3).optional(), endpoints: z.tuple([vertex, vertex]).optional(),
    textStyle: z.object({
      // Cualquiera de las 11 familias del catálogo (Sans-Serif, Serif y Caligráficas).
      fontFamily: z.enum(FONT_IDS),
      fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), italic: z.boolean(),
      align: z.enum(['left', 'center', 'right']), letterSpacing: z.number().min(-50).max(200),
    }).optional(),
    vertices: z.array(vertex).min(3).max(20).optional(),
    // Trazados Bézier (pluma / curva suavizada): nodos con tipo y manejadores opcionales.
    nodes: z.array(z.object({
      x: number, y: number, type: z.enum(['corner', 'smooth']), in: vertex.optional(), out: vertex.optional(),
    })).min(2).max(4096).optional(),
    closed: z.boolean().optional(),
    // Arco circular / flecha curva.
    arc: z.object({ startAngle: number.min(0).max(360), sweep: number.min(-360).max(360) }).optional(),
  }).refine((vector) => vector.tool !== 'polygon' || !!vector.vertices)
    .refine((vector) => (vector.tool !== 'pen' && vector.tool !== 'curve') || !!vector.nodes)
    .refine((vector) => vector.tool !== 'arc' || !!vector.arc).optional(),
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
const objectIdList = z.string().max(20000).regex(/^o[1-9]\d*(,o[1-9]\d*)*$/);
const parameters = z.record(z.string(), z.union([number, z.string(), z.boolean()])).superRefine((input, ctx) => {
  if (
    (input.color !== undefined && !paint.safeParse(input.color).success) ||
    (input.targetFillColor !== undefined && !paint.safeParse(input.targetFillColor).success) ||
    (input.targetStrokeColor !== undefined && !paint.safeParse(input.targetStrokeColor).success) ||
    (input.revertOnEnd !== undefined && typeof input.revertOnEnd !== 'boolean') ||
    (input.targetStrokeWidth !== undefined && (typeof input.targetStrokeWidth !== 'number' || input.targetStrokeWidth < 0 || input.targetStrokeWidth > 20)) ||
    (input.targetFillOpacity !== undefined && (typeof input.targetFillOpacity !== 'number' || input.targetFillOpacity < 0 || input.targetFillOpacity > 1)) ||
    (input.axis !== undefined && input.axis !== 'x' && input.axis !== 'y' && input.axis !== 'z') ||
    (input.to !== undefined && !objectId.safeParse(input.to).success) ||
    (input.term !== undefined && !/^t[1-9]\d*$/.test(String(input.term))) ||
    (input.toTerm !== undefined && !/^t[1-9]\d*$/.test(String(input.toTerm))) ||
    (input.glyphs !== undefined && !/^[\d,\s-]*$/.test(String(input.glyphs))) ||
    (input.subElementId !== undefined && !/^(plot|point):[a-z]{1,3}\d{1,6}$/.test(String(input.subElementId))) ||
    // Transformación de grupo: listas de ids de objeto raíz separadas por comas.
    (input.sourceObjectIds !== undefined && !objectIdList.safeParse(input.sourceObjectIds).success) ||
    (input.targetObjectIds !== undefined && !objectIdList.safeParse(input.targetObjectIds).success) ||
    (input.keepSource !== undefined && typeof input.keepSource !== 'boolean') ||
    // Enfoque / Spotlight: objetivos `"o1:3,4;o2:3,4;o3"` y controles dentro de sus rangos.
    (input.targets !== undefined && (typeof input.targets !== 'string' || input.targets.length > 20000 || !FOCUS_TARGETS_RE.test(input.targets))) ||
    (input.dimOpacity !== undefined && (typeof input.dimOpacity !== 'number' ||
      input.dimOpacity < FOCUS_LIMITS.dimOpacity.min || input.dimOpacity > FOCUS_LIMITS.dimOpacity.max)) ||
    (input.pulseScale !== undefined && (typeof input.pulseScale !== 'number' ||
      input.pulseScale < FOCUS_LIMITS.pulseScale.min || input.pulseScale > FOCUS_LIMITS.pulseScale.max)) ||
    (input.highlightColor !== undefined && !paint.safeParse(input.highlightColor).success) ||
    (input.useHighlightColor !== undefined && typeof input.useHighlightColor !== 'boolean') ||
    // Contorno de Enfoque / Spotlight: interruptor, color y grosor (px, 0–20).
    (input.useStrokeColor !== undefined && typeof input.useStrokeColor !== 'boolean') ||
    (input.highlightStrokeColor !== undefined && !paint.safeParse(input.highlightStrokeColor).success) ||
    (input.highlightStrokeWidth !== undefined && (typeof input.highlightStrokeWidth !== 'number' ||
      input.highlightStrokeWidth < FOCUS_LIMITS.highlightStrokeWidth.min || input.highlightStrokeWidth > FOCUS_LIMITS.highlightStrokeWidth.max)) ||
    // Indicate: relleno activable y contorno propio (color + grosor en px, 0–20).
    (input.useFill !== undefined && typeof input.useFill !== 'boolean') ||
    (input.strokeColor !== undefined && !paint.safeParse(input.strokeColor).success) ||
    (input.strokeWidth !== undefined && (typeof input.strokeWidth !== 'number' ||
      input.strokeWidth < INDICATE_STROKE_LIMITS.min || input.strokeWidth > INDICATE_STROKE_LIMITS.max))
  ) ctx.addIssue({ code: 'custom', message: 'Parámetros de animación no válidos.' });
});
// Catálogo completo de efectos (los 4 originales siguen siendo válidos: los proyectos antiguos abren igual).
const sound = z.enum(SOUND_IDS);
const sfxClip = z.object({
  id: z.string().regex(/^s[1-9]\d*$/), sound, start: nonnegative, duration: positive.max(60),
  volume: number.min(0).max(SFX_VOLUME_MAX),
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
      'indicate', 'circumscribe', 'focus', 'transform', 'transformMatch', 'colorChange', 'groupTransform', 'disappear',
    ]),
    start: nonnegative, duration: positive, sound: sound.nullable(),
    parameters,
  }).refine((clip) => clip.parameters.targets === undefined || clip.type === 'focus', { message: 'Objetivos de enfoque en un clip que no es Focus.' })
    .refine((clip) => clip.type !== 'disappear' || clip.parameters.mode === undefined || clip.parameters.mode === 'fade' || clip.parameters.mode === 'shrink',
    { message: 'Modo de salida no válido.' })),
  // Grupos guardados con etiqueta (opcional: los archivos antiguos no los tienen).
  savedGroups: z.array(z.object({
    id: z.string().regex(/^g[1-9]\d*$/),
    name: z.string().trim().min(1).max(SAVED_GROUP_NAME_MAX),
    objectIds: z.array(objectId).max(5000),
  })).max(500).optional(),
  // Efectos de sonido sueltos de la pista «Efectos» (opcional: los archivos antiguos no los tienen).
  sfx: z.array(sfxClip).max(2000).optional(),
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
      clip.type !== 'orbit' && (clip.type === 'groupTransform' || (clip.type === 'focus' && clip.parameters.targets !== undefined)
        || !dropped.has(owner(clip.targetId)))
      && !dropped.has(String(clip.parameters.to ?? ''))),
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
  // Transformaciones de grupo: ambas listas deben existir y referirse a objetos del archivo; los objetos 3D
  // descartados se quitan de las listas (y el clip desaparece si un grupo queda vacío).
  if (p.clips.some((clip) => clip.type === 'groupTransform' && (
    !parseObjectIds(clip.parameters.sourceObjectIds).length || !parseObjectIds(clip.parameters.targetObjectIds).length ||
    [...parseObjectIds(clip.parameters.sourceObjectIds), ...parseObjectIds(clip.parameters.targetObjectIds)]
      .some((id) => !targets.has(id) && !dropped.has(id))
  ))) throw new Error('El archivo contiene una transformación de grupo con objetos inexistentes.');
  // Enfoque / Spotlight: todos sus objetivos deben existir (los objetos 3D descartados se quitan después).
  if (p.clips.some((clip) => clip.type === 'focus' && clip.parameters.targets !== undefined && (
    !parseFocusTargets(clip.parameters.targets).length ||
    parseFocusTargets(clip.parameters.targets).some((entry) => !targets.has(entry.objectId) && !dropped.has(entry.objectId))
  ))) throw new Error('El archivo contiene un enfoque con objetos inexistentes.');
  // Grupos guardados: ids únicos; se quitan los miembros inexistentes (o 3D descartados) y los grupos vacíos.
  if (p.savedGroups && new Set(p.savedGroups.map((group) => group.id)).size !== p.savedGroups.length) {
    throw new Error('El archivo contiene grupos guardados con identificadores repetidos.');
  }
  const savedGroups = pruneSavedGroups(p.savedGroups, (id) => targets.has(id));
  p.savedGroups = savedGroups?.length ? savedGroups : undefined;
  const droppedIds = new Set([...dropped].map(String));
  p.clips = pruneFocusClips(pruneGroupClips(p.clips as Project['clips'], droppedIds), droppedIds) as typeof p.clips;
  const clipIds = new Set(p.clips.map((clip) => clip.id));
  if (
    targets.size !== objects.length || clipIds.size !== p.clips.length ||
    objects.some(({ id }) => Number(id.slice(1)) > p.counters.obj) ||
    p.clips.some(({ id }) => Number(id.slice(1)) > p.counters.clip) ||
    [...Object.keys(p.styles), ...p.clips.map((clip) => clip.targetId)]
      .some((id) => !targets.has(id.split('.')[0]))
  ) throw new Error('El archivo contiene identificadores de escena inconsistentes.');

  if (p.sfx && new Set(p.sfx.map((s) => s.id)).size !== p.sfx.length) {
    throw new Error('El archivo contiene efectos de sonido con identificadores repetidos.');
  }
  p.sfx = p.sfx?.length ? p.sfx : undefined;

  let track: Project['voice'] = null;
  if (p.voice) {
    const { base64, mime, ...metadata } = p.voice;
    const bytes = Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
    track = { ...metadata, source: new Blob([bytes], { type: mime }) };
  }
  return { ...p, clips: p.clips as Project['clips'], objects, voice: track };
}
