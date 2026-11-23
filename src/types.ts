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
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 10;

export type Shape3D = 'axes' | 'paraboloid' | 'sphere' | 'vector';
export const SHAPE3D_LABEL: Record<Shape3D, string> = {
  axes: 'Ejes cartesianos',
  paraboloid: 'Paraboloide',
  sphere: 'Esfera',
  vector: 'Vector 3D',
};

export type SoundId = 'chalk' | 'pop' | 'radar' | 'sparkle';
export const SOUND_LABEL: Record<SoundId, string> = {
  chalk: 'Trazo de tiza',
  pop: 'Pop suave',
  radar: 'Radar ping',
  sparkle: 'Brillo de acierto',
};
export const SOUND_IDS = Object.keys(SOUND_LABEL) as SoundId[];

export type ClipType =
  | 'draw' | 'radar' | 'glow' | 'appear' | 'rotate' | 'orbit'
  | 'indicate' | 'circumscribe' | 'focus' | 'transform' | 'transformMatch';
export const CLIP_LABEL: Record<ClipType, string> = {
  draw: 'Escribir / Dibujar',
  radar: 'Radar',
  glow: 'Brillar',
  appear: 'Aparecer / Deslizar',
  rotate: 'Rotar',
  orbit: 'Orbitar cámara',
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

export type VectorTool = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'polygon';
export type ArrowTip = 'triangle' | 'open' | 'both' | 'none';
export interface Vertex { x: number; y: number }

export interface VectorGeometry {
  tool: VectorTool;
  reverseX?: boolean;
  reverseY?: boolean;
  tip?: ArrowTip;
  text?: string;
  vertices?: Vertex[];
}

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
  /** SVG original o generado por MathJax, para reconstruir el objeto al abrir un archivo. */
  sourceSvg: string;
  /** Solo fórmulas: estilo por glifo (índice → propiedades). */
  glyphStyles?: Record<string, GlyphStyle>;
  /** Solo fórmulas: términos con nombre. */
  terms?: Term[];
}

export interface Obj3D {
  id: string;
  kind: 'shape3d';
  name: string;
  shape: Shape3D;
  scale: number;
  /** Rotación base alrededor del eje Y (grados). */
  rotation: number;
}

export type SceneObject = Obj2D | Obj3D;
export const is2D = (o: SceneObject): o is Obj2D => o.kind !== 'shape3d';

export interface NodeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dotted';
  opacity?: number;
  vertices?: Vertex[];
  /** Solo nodos hijos; la escala de un objeto raíz vive en el propio objeto. */
  scale?: number;
  tx?: number;
  ty?: number;
}

export interface CameraState {
  az: number;
  el: number;
  dist: number;
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
  camera: CameraState;
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
