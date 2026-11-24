import { z } from 'zod';
import { is2D, type Project } from '../types';
import { prepareSvg } from './svgImport';

const number = z.number();
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
const baseObject = { id: objectId, name: z.string(), scale: positive, rotation: number };
const object2D = z.object({
  ...baseObject, kind: z.enum(['svg', 'formula']), sourceSvg: z.string(),
  vector: z.object({
    tool: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'text', 'polygon']),
    reverseX: z.boolean().optional(), reverseY: z.boolean().optional(),
    tip: z.enum(['triangle', 'open', 'both', 'none']).optional(), text: z.string().optional(),
    textStyle: z.object({
      fontFamily: z.enum(['Inter', 'Space Grotesk', 'Lora', 'Playfair Display', 'Great Vibes', 'Dancing Script']),
      fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), italic: z.boolean(),
      align: z.enum(['left', 'center', 'right']), letterSpacing: z.number().min(-50).max(200),
    }).optional(),
    vertices: z.array(vertex).min(3).max(20).optional(),
  }).refine((vector) => vector.tool !== 'polygon' || !!vector.vertices).optional(),
  x: number, y: number, bw: positive, bh: positive, tex: z.string().optional(),
  glyphStyles: z.record(z.string().regex(/^\d+$/), glyphStyle).optional(), terms: z.array(term).optional(),
});
const obj3D = z.object({
  ...baseObject, kind: z.literal('shape3d'), shape: z.enum(['axes', 'paraboloid', 'sphere', 'vector']),
});
const style = z.object({
  fill: paint.optional(), stroke: paint.optional(), strokeWidth: nonnegative.optional(),
  lineStyle: z.enum(['solid', 'dotted']).optional(), opacity: number.min(0).max(1).optional(),
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
    (input.glyphs !== undefined && !/^[\d,\s-]*$/.test(String(input.glyphs)))
  ) ctx.addIssue({ code: 'custom', message: 'Parámetros de animación no válidos.' });
});
const voice = z.object({
  name: z.string(), start: nonnegative, duration: positive, volume: number.min(0).max(1.5),
});
const voiceFile = voice.extend({ mime: z.string(), base64: z.base64() });
const project = z.object({
  format: z.enum(['9:16', '16:9']),
  background: z.enum(['board', 'grid', 'light']),
  objects: z.array(z.union([object2D, obj3D])),
  styles: z.record(targetId, style),
  clips: z.array(z.object({
    id: clipId, targetId, type: z.enum([
      'draw', 'radar', 'glow', 'appear', 'rotate', 'orbit',
      'indicate', 'circumscribe', 'focus', 'transform', 'transformMatch',
    ]),
    start: nonnegative, duration: positive, sound: z.enum(['chalk', 'pop', 'radar', 'sparkle']).nullable(),
    parameters,
  })),
  camera: z.object({ az: number, el: number, dist: positive }),
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
  const objects = p.objects.map((object) => {
    if (!is2D(object)) return object;
    const { markup, ...rest } = object;
    return rest;
  });
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
  const p = result.data.project;
  const objects = p.objects.map((object) => {
    if (object.kind === 'shape3d') return object;
    // El archivo nunca se monta directamente. Se reconstruyen los mismos IDs de nodo.
    const { markup } = prepareSvg(object.sourceSvg, object.id);
    return { ...object, markup };
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
  return { ...p, objects, voice: track };
}
