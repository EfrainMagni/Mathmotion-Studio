export type StageFormat = '9:16' | '16:9';
export type StageBackground = 'board' | 'grid' | 'light';

/** Dimensiones lógicas del escenario (no son la resolución de captura). */
export const STAGE_SIZES: Record<StageFormat, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
};

export const BACKGROUND_COLOR: Record<StageBackground, string> = {
  board: '#141414',
  grid: '#141414',
  light: '#f8fafc',
};

export const FPS = 30;

/** Rango de escala libre del inspector (ecuaciones, formas y glifos). */
export const SCALE_MIN = 0.005;
export const SCALE_MAX = 20;
export const SCALE_STEP = 0.005;

export type SoundId = 'chalk' | 'pop' | 'radar' | 'sparkle';
export const SOUND_LABEL: Record<SoundId, string> = {
  chalk: 'Trazo de tiza',
  pop: 'Pop suave',
  radar: 'Radar ping',
  sparkle: 'Brillo de acierto',
};
export const SOUND_IDS = Object.keys(SOUND_LABEL) as SoundId[];

export type ClipType =
  | 'draw' | 'radar' | 'glow' | 'appear' | 'rotate'
  | 'indicate' | 'circumscribe' | 'focus' | 'transform' | 'transformMatch';
export const CLIP_LABEL: Record<ClipType, string> = {
  draw: 'Escribir / Dibujar',
  radar: 'Radar',
  glow: 'Brillar',
  appear: 'Aparecer / Deslizar',
  rotate: 'Rotar',
  indicate: 'Indicate',
  circumscribe: 'Circumscribe',
  focus: 'FocusOn',
  transform: 'Transform',
  transformMatch: 'TransformMatchingTex',
};

export type ClipParams = Record<string, number | string | boolean>;

/** Un clip de animación. `start` es tiempo absoluto desde el inicio de la escena (s). */
export interface Clip {
  id: string;
  targetId: string;
  type: ClipType;
  start: number;
  duration: number;
  parameters: ClipParams;
  sound: SoundId | null;
}

/** Id estable de un glifo de fórmula: `<objeto>.g<índice>`. */
export const glyphIdOf = (objectId: string, index: number) => `${objectId}.g${index}`;

/**
 * Transformación dirigida glifo → glifo (`TransformFromCopy` / `ReplacementTransform` de submobjects).
 * Es un clip `transform` cuyos parámetros incluyen `targetGlyphIds`; se guardan como texto
 * (`"a.g0,a.g1"`) porque `ClipParams` solo admite escalares. `sourceGlyphIds[i]` viaja a `targetGlyphIds[i]`.
 */
export interface GlyphTransformSpec {
  sourceObjectId: string;
  sourceGlyphIds: string[];
  targetObjectId: string;
  targetGlyphIds: string[];
  /** `true` (por defecto): una copia viaja y el origen permanece. `false`: el origen se consume. */
  keepSource: boolean;
  /** Opcional: los conectores (`·`, `+`, `=`…) sin glifo dirigido brotan al aterrizar los vecinos. */
  revealConnectors?: boolean;
}

export function glyphTransformParams(spec: GlyphTransformSpec): ClipParams {
  return {
    to: spec.targetObjectId,
    sourceGlyphIds: spec.sourceGlyphIds.join(','),
    targetGlyphIds: spec.targetGlyphIds.join(','),
    keepSource: spec.keepSource,
    ...(spec.revealConnectors ? { revealConnectors: true } : {}),
  };
}

/** Índices de los ids `<objeto>.g<n>` que pertenecen a `objectId`, en el orden dado (sin ordenar ni deduplicar). */
export function parseGlyphIds(objectId: string, text: unknown): number[] {
  if (typeof text !== 'string') return [];
  const prefix = `${objectId}.g`;
  const out: number[] = [];
  for (const part of text.split(',')) {
    const id = part.trim();
    if (!id.startsWith(prefix)) continue;
    const index = Number(id.slice(prefix.length));
    if (Number.isInteger(index) && index >= 0) out.push(index);
  }
  return out;
}

/** Especificación dirigida de un clip, o `null` si no es una transformación glifo → glifo válida. */
export function glyphTransformOf(clip: Pick<Clip, 'type' | 'targetId' | 'parameters'>): GlyphTransformSpec | null {
  const p = clip.parameters;
  if (clip.type !== 'transform' || typeof p.to !== 'string' || typeof p.targetGlyphIds !== 'string') return null;
  const sourceObjectId = clip.targetId.split('.')[0];
  const sourceGlyphIds = parseGlyphIds(sourceObjectId, p.sourceGlyphIds).map((i) => glyphIdOf(sourceObjectId, i));
  const targetGlyphIds = parseGlyphIds(p.to, p.targetGlyphIds).map((i) => glyphIdOf(p.to as string, i));
  const n = Math.min(sourceGlyphIds.length, targetGlyphIds.length);
  if (!n || sourceObjectId === p.to) return null;
  return {
    sourceObjectId, targetObjectId: p.to, keepSource: p.keepSource !== false, revealConnectors: p.revealConnectors === true,
    sourceGlyphIds: sourceGlyphIds.slice(0, n), targetGlyphIds: targetGlyphIds.slice(0, n),
  };
}

/** Etiqueta del clip (distingue la transformación dirigida de glifos de un Transform normal). */
export function clipLabel(clip: Pick<Clip, 'type' | 'targetId' | 'parameters'>): string {
  if (clip.type === 'appear' && clip.parameters.mode === 'pop') return 'GrowFromCenter (Pop)';
  const spec = glyphTransformOf(clip);
  if (spec) return spec.keepSource ? 'TransformFromCopy' : 'ReplacementTransform (glifos)';
  return CLIP_LABEL[clip.type];
}

export type VectorTool = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'polygon';
export type ArrowTip = 'triangle' | 'open' | 'both' | 'none';
export type LineTip = 'none' | 'stealth' | 'right';
/** Valores de puntas de proyectos antiguos; se normalizan a `stealth` o `right` al leerlos. */
export type LegacyLineTip = 'triangle' | 'open' | 'circle';
export interface Vertex { x: number; y: number }

export type FontId = 'Inter' | 'Space Grotesk' | 'Lora' | 'Playfair Display' | 'Great Vibes' | 'Dancing Script';
export type FontCategory = 'Divulgación' | 'Letra corrida';
export type FontWeight = 400 | 600 | 700;
export type TextAlign = 'left' | 'center' | 'right';

export interface FontInfo {
  id: FontId;
  category: FontCategory;
  description: string;
  fallback: string;
  weights: FontWeight[];
  italic: boolean;
}

/** Catálogo curado; debe coincidir con el `<link>` de Google Fonts de `index.html`. */
export const FONT_CATALOG: FontInfo[] = [
  { id: 'Inter', category: 'Divulgación', description: 'Sans geométrica moderna', fallback: 'system-ui, sans-serif', weights: [400, 600, 700], italic: true },
  { id: 'Space Grotesk', category: 'Divulgación', description: 'Sans técnica contemporánea', fallback: 'system-ui, sans-serif', weights: [400, 600, 700], italic: false },
  { id: 'Lora', category: 'Divulgación', description: 'Serif editorial clásica', fallback: 'Georgia, serif', weights: [400, 600, 700], italic: true },
  { id: 'Playfair Display', category: 'Divulgación', description: 'Serif editorial de alto contraste', fallback: 'Georgia, serif', weights: [400, 600, 700], italic: true },
  { id: 'Great Vibes', category: 'Letra corrida', description: 'Caligráfica fluida y formal', fallback: 'cursive', weights: [400], italic: false },
  { id: 'Dancing Script', category: 'Letra corrida', description: 'Manuscrita moderna y legible', fallback: 'cursive', weights: [400, 600, 700], italic: false },
];
export const fontInfo = (id: string): FontInfo => FONT_CATALOG.find((f) => f.id === id) ?? FONT_CATALOG[0];
export const fontStack = (id: FontId) => `'${id}', ${fontInfo(id).fallback}`;

/** Tipografía de un objeto de texto. Si falta, se usa el aspecto original (sans-serif ajustada al cuadro). */
export interface TextStyle {
  fontFamily: FontId;
  fontWeight: FontWeight;
  italic: boolean;
  align: TextAlign;
  /** Espaciado entre letras en px lógicos. */
  letterSpacing: number;
}
export const DEFAULT_TEXT_STYLE: TextStyle = { fontFamily: 'Inter', fontWeight: 400, italic: false, align: 'left', letterSpacing: 0 };

export interface VectorGeometry {
  tool: VectorTool;
  reverseX?: boolean;
  reverseY?: boolean;
  tip?: ArrowTip;
  startTip?: LineTip | LegacyLineTip;
  endTip?: LineTip | LegacyLineTip;
  tipScale?: number;
  endpoints?: [Vertex, Vertex];
  text?: string;
  textStyle?: TextStyle;
  vertices?: Vertex[];
}

export type PlaneArrowTips = 'both' | 'positive' | 'none';

/** Gráfica `f(x)` dentro de un plano (estilo `plane.plot(...)` de Manim). `expression` usa `x`, `+ - * / ^`, funciones y `pi`/`e`. */
export interface PlanePlot {
  id: string;
  expression: string;
  color: string;
  width: number;
  /** Extremos del dominio; por defecto, los del plano. */
  xStart?: number;
  xEnd?: number;
  visible: boolean;
}

/** Punto coordenado `(x, y)` dentro de un plano (estilo `Dot(plane.c2p(x, y))`). */
export interface PlanePoint {
  id: string;
  x: number;
  y: number;
  color: string;
  radius: number;
  label?: string;
  /** Líneas punteadas perpendiculares hacia los ejes. */
  showGuideLines?: boolean;
  visible: boolean;
}

/**
 * Geometría de un plano cartesiano estilo Manim `NumberPlane` (objeto nativo `cartesianPlane`).
 * `width`/`height` son px lógicos del escenario antes de aplicar `scale` del objeto; posición, rotación
 * y opacidad viven en el propio objeto (`x`, `y`, `rotation`) y en su estilo (`opacity`).
 */
export interface PlaneGeometry {
  width: number;
  height: number;
  xMin: number; xMax: number; xStep: number;
  yMin: number; yMax: number; yStep: number;
  /** Líneas de cuadrícula por cada paso principal (1 = sin subdivisión). */
  subdivisions: number;
  showAxes: boolean;
  axisColor: string;
  axisWidth: number;
  arrowTips: PlaneArrowTips;
  showAxisLabels: boolean;
  xLabel: string;
  yLabel: string;
  showGrid: boolean;
  gridColor: string;
  gridOpacity: number;
  gridWidth: number;
  showSubGrid: boolean;
  subGridColor: string;
  subGridOpacity: number;
  subGridWidth: number;
  showTicks: boolean;
  tickLength: number;
  showNumbers: boolean;
  numberColor: string;
  numberSize: number;
  showOriginZero: boolean;
  plots?: PlanePlot[];
  points?: PlanePoint[];
}

/** Sub-elemento de un plano al que apunta un clip (`parameters.subElementId`): `plot:<id>` o `point:<id>`. */
export const PLANE_SUB_ID = /^(plot|point):([a-z]{1,3}\d{1,6})$/;

export function planeSubElementOf(clip: Pick<Clip, 'parameters'>): { kind: 'plot' | 'point'; id: string } | null {
  const raw = clip.parameters.subElementId;
  const match = typeof raw === 'string' ? PLANE_SUB_ID.exec(raw) : null;
  return match ? { kind: match[1] as 'plot' | 'point', id: match[2] } : null;
}

/** Nombre legible del sub-elemento de un plano (para la línea de tiempo): `f(x) = x^2` o `Punto (2, 2)`. */
export function planeSubLabel(plane: PlaneGeometry | undefined, sub: { kind: 'plot' | 'point'; id: string }): string {
  const round = (value: number) => String(Number(value.toFixed(2)));
  if (sub.kind === 'plot') {
    const plot = plane?.plots?.find((entry) => entry.id === sub.id);
    return plot ? `f(x) = ${plot.expression.trim() || '…'}` : 'f(x) (eliminada)';
  }
  const point = plane?.points?.find((entry) => entry.id === sub.id);
  return point ? `Punto${point.label ? ` ${point.label}` : ''} (${round(point.x)}, ${round(point.y)})` : 'Punto (eliminado)';
}

/** Colores clásicos 3Blue1Brown (cuadrícula principal, subcuadrícula, ejes). */
export const PLANE_STYLE_3B1B = {
  gridColor: '#58C4DD', gridOpacity: 0.45, subGridColor: '#29ABCA', subGridOpacity: 0.18, axisColor: '#FFFFFF',
} as const;

export const DEFAULT_PLANE: PlaneGeometry = {
  width: 720, height: 450,
  xMin: -5, xMax: 5, xStep: 1,
  yMin: -3, yMax: 3, yStep: 1,
  subdivisions: 2,
  showAxes: true, axisColor: '#FFFFFF', axisWidth: 2.2, arrowTips: 'positive',
  showAxisLabels: true, xLabel: 'x', yLabel: 'y',
  showGrid: true, gridColor: '#58C4DD', gridOpacity: 0.45, gridWidth: 1.1,
  showSubGrid: true, subGridColor: '#29ABCA', subGridOpacity: 0.18, subGridWidth: 0.6,
  showTicks: true, tickLength: 8,
  showNumbers: true, numberColor: '#E5E7EB', numberSize: 13, showOriginZero: false,
};

/** Propiedades propias de un glifo de fórmula (clave: índice del glifo). */
export interface GlyphStyle {
  color?: string;
  scale?: number;
  opacity?: number;
}

/** Selección de glifos con nombre, para animarla de forma independiente. */
export interface Term {
  id: string;
  name: string;
  glyphs: number[];
}

export interface Obj2D {
  id: string;
  kind: 'svg' | 'formula';
  name: string;
  /** SVG saneado, con ids con prefijo, estilos con ámbito y `data-mm-id` en cada nodo. */
  markup: string;
  /** Tamaño natural (viewBox) en unidades de usuario. */
  bw: number;
  bh: number;
  /** Centro en coordenadas lógicas del escenario. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  tex?: string;
  vector?: VectorGeometry;
  /** Plano cartesiano nativo (`cartesianPlane`): su SVG se genera siempre a partir de esta geometría. */
  plane?: PlaneGeometry;
  /** SVG original o generado por MathJax, para reconstruir el objeto al abrir un archivo. */
  sourceSvg: string;
  /** Solo fórmulas: estilo por glifo (índice → propiedades). */
  glyphStyles?: Record<string, GlyphStyle>;
  /** Solo fórmulas: términos con nombre. */
  terms?: Term[];
}

/** El editor es 100% 2D: un objeto de escena es siempre un `Obj2D`. */
export type SceneObject = Obj2D;

export type GradientMode = 'solid' | 'linear' | 'radial';
/** Parada de color de un degradado; `offset` en % (0–100). */
export interface GradientStop { id: string; offset: number; color: string }
/** Relleno en degradado de un nodo (`solid` equivale a no tener degradado). `angle` en grados (solo lineal). */
export interface FillGradient { mode: GradientMode; angle: number; stops: GradientStop[] }

export interface NodeStyle {
  fill?: string;
  /** Tiene prioridad sobre `fill` cuando `mode` es `linear` o `radial`. */
  fillGradient?: FillGradient;
  stroke?: string;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  dashGap?: number;
  lineCap?: 'butt' | 'round';
  /** Unión de esquinas del trazo (estilo Illustrator): afilada (`miter`) o redondeada (`round`). */
  lineJoin?: 'miter' | 'round';
  /** Opacidad solo del relleno (0–1), independiente del trazo y de la opacidad global. */
  fillOpacity?: number;
  opacity?: number;
  vertices?: Vertex[];
  /** Solo nodos hijos; la escala de un objeto raíz vive en el propio objeto. */
  scale?: number;
  tx?: number;
  ty?: number;
}

export interface VoiceMeta {
  source: Blob;
  name: string;
  duration: number;
  start: number;
  volume: number;
}

export interface Project {
  format: StageFormat;
  background: StageBackground;
  objects: SceneObject[];
  styles: Record<string, NodeStyle>;
  clips: Clip[];
  voice: VoiceMeta | null;
  counters: { obj: number; clip: number };
}

export function sceneDuration(p: Project): number {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.start + c.duration);
  if (p.voice) end = Math.max(end, p.voice.start + p.voice.duration);
  return Math.max(end, 0.5);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
