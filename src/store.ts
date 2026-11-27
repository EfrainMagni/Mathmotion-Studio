import { History } from './engine/history';
import { prepareSvg } from './engine/svgImport';
import { VECTOR_LABEL, nodesBounds, toggleNodeType, translateNodes, vectorSvg } from './engine/vector';
import { normalizePlane, planeSvg } from './engine/cartesianPlane';
import { useSyncExternalStore } from 'react';
import {
  STAGE_SIZES,
  SAVED_GROUP_NAME_MAX,
  groupTransformParams,
  pruneGroupClips,
  pruneSavedGroups,
  type SavedGroup,
  type Clip,
  type ClipParams,
  type ClipType,
  type GlyphStyle,
  type NodeStyle,
  type Obj2D,
  type PathNode,
  type PlaneGeometry,
  type Project,
  type SoundId,
  type SceneObject,
  type StageBackground,
  type SceneBackground,
  type SceneBackgroundType,
  GRID_BG_COLOR,
  normalizeSceneBackground,
  resolveSceneBackground,
  type StageFormat,
  type Box,
  type VoiceMeta,
  type VectorGeometry,
  type VectorTool,
  type Vertex,
} from './types';

/** Modos de alineación estilo Illustrator (bordes y centros de la caja envolvente). */
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export type RecordingPhase = 'idle' | 'picker' | 'preparing' | 'recording' | 'finishing';

export interface RecordingState {
  phase: RecordingPhase;
  message: string | null;
  captureSize: { w: number; h: number } | null;
  lastFile: { url: string; name: string; size: number; mime: string } | null;
}

export interface UIState {
  selection: string | null;
  /**
   * Selección múltiple (marquesina o Mayús+clic): ids de objetos raíz. Vacía en selección simple; cuando tiene
   * elementos, `selection` es el objeto principal (el último añadido) y el inspector lo muestra.
   */
  multiSelection: string[];
  selectedClip: string | null;
  time: number;
  playing: boolean;
  speed: 0.5 | 1 | 1.5;
  vectorTool: VectorTool | null;
  pointerTool: 'select' | 'direct' | 'hand';
  polygonSides: number;
  polygonRadius: number;
  polygonRequest: Vertex | 'options' | null;
  vectorText: string;
  showGuides: boolean;
  recordQuality: 'light' | 'standard' | 'hd' | 'max';
  recording: RecordingState;
  notice: { kind: 'error' | 'info'; text: string } | null;
  /** Se incrementa cuando cambia el árbol de nodos SVG montado. */
  treeVersion: number;
  /** Fórmula en «Modo Edición de Términos» (sus glifos son seleccionables). */
  termEdit: string | null;
  /** Índices de los glifos seleccionados dentro de `termEdit`. */
  glyphSel: number[];
  /** Nodo activo del trazado Bézier seleccionado (Selección Directa), o `null`. */
  pathNode: number | null;
  /**
   * Grupo origen fijado para una «Transformación de Grupo» (paso 1), a la espera de que el usuario seleccione el
   * grupo destino (paso 2). Estado temporal de la interfaz: no forma parte del proyecto ni del historial.
   */
  pendingTransformSourceIds: string[] | null;
}

export interface State {
  project: Project;
  ui: UIState;
}

export function defaultProject(): Project {
  return {
    format: '16:9',
    background: 'board',
    objects: [],
    styles: {},
    clips: [],
    voice: null,
    counters: { obj: 0, clip: 0 },
  };
}

function defaultUI(): UIState {
  return {
    selection: null,
    multiSelection: [],
    selectedClip: null,
    time: 0,
    playing: false,
    speed: 1,
    vectorTool: null,
    pointerTool: 'select',
    polygonSides: 5,
    polygonRadius: 160,
    polygonRequest: null,
    vectorText: 'Texto',
    showGuides: true,
    recordQuality: 'hd',
    recording: { phase: 'idle', message: null, captureSize: null, lastFile: null },
    notice: null,
    treeVersion: 0,
    termEdit: null,
    glyphSel: [],
    pathNode: null,
    pendingTransformSourceIds: null,
  };
}

let state: State = { project: defaultProject(), ui: defaultUI() };
const listeners = new Set<() => void>();

let projectGeneration = 0;
let objectSerial = 0;
let history = new History<Project>();

/** Una selección múltiple de menos de dos objetos equivale a una selección simple. */
const NO_MULTI: string[] = [];
function keepMulti(ids: string[]): string[] {
  return ids.length > 1 ? ids : NO_MULTI;
}

/** Conserva solo los ids del grupo origen pendiente que siguen existiendo (o `null` si no queda ninguno). */
function keepPending(ids: string[] | null, exists: (id: string) => boolean): string[] | null {
  if (!ids) return null;
  const kept = ids.filter(exists);
  return kept.length ? kept : null;
}

/** Ids de los objetos raíz seleccionados (uno o varios). */
export function selectedObjectIds(ui: Pick<UIState, 'selection' | 'multiSelection'>): string[] {
  if (ui.multiSelection.length) return ui.multiSelection;
  const root = ui.selection?.split('.')[0];
  return root ? [root] : [];
}

function restoreHistory(direction: 'undo' | 'redo') {
  const project = history[direction](state.project);
  if (!project) return;
  const { selection, selectedClip, termEdit } = state.ui;
  const editing = project.objects.some((object) => object.id === termEdit);
  state = {
    project,
    ui: {
      ...state.ui,
      selection: project.objects.some((object) => object.id === selection?.split('.')[0]) ? selection : null,
      multiSelection: keepMulti(state.ui.multiSelection.filter((id) => project.objects.some((object) => object.id === id))),
      selectedClip: project.clips.some((clip) => clip.id === selectedClip) ? selectedClip : null,
      termEdit: editing ? termEdit : null,
      glyphSel: editing ? state.ui.glyphSel : [],
      pendingTransformSourceIds: keepPending(state.ui.pendingTransformSourceIds, (id) => project.objects.some((object) => object.id === id)),
    },
  };
  listeners.forEach((listener) => listener());
}

export const store = {
  projectGeneration: () => projectGeneration,
  getState: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  undo: () => restoreHistory('undo'),
  redo: () => restoreHistory('redo'),
  setProject(fn: (p: Project) => Project, group?: symbol) {
    const next = fn(state.project);
    if (next === state.project) return;
    history.record(state.project, group);
    state = { ...state, project: next };
    listeners.forEach((l) => l());
  },
  setUi(patch: Partial<UIState>) {
    // Cambiar la selección principal a algo ajeno al grupo deshace la selección múltiple.
    const multi = state.ui.multiSelection;
    if ('selection' in patch && !('multiSelection' in patch) && multi.length && !multi.includes(patch.selection?.split('.')[0] ?? '')) {
      patch = { ...patch, multiSelection: NO_MULTI };
    }
    let changed = false;
    for (const k of Object.keys(patch) as (keyof UIState)[]) {
      if (state.ui[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ui: { ...state.ui, ...patch } };
    listeners.forEach((l) => l());
  },
  /** Sustituye el proyecto y limpia la selección y los controles de reproducción. */
  replaceProject(p: Project) {
    projectGeneration++;
    history = new History<Project>();
    objectSerial = p.counters.obj;
    state = {
      ...state,
      project: p,
      ui: {
        ...state.ui, selection: null, multiSelection: NO_MULTI, selectedClip: null, time: 0,
        playing: false, vectorTool: null, pointerTool: 'select', polygonRequest: null, notice: null,
        termEdit: null, glyphSel: [], pathNode: null, pendingTransformSourceIds: null,
      },
    };
    listeners.forEach((l) => l());
  },
};

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(state),
    () => selector(state),
  );
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function stripNodeKeys<T>(rec: Record<string, T>, objId: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k !== objId && !k.startsWith(objId + '.')) out[k] = v;
  }
  return out;
}

export function defaultClipParams(type: ClipType): ClipParams {
  switch (type) {
    case 'radar':
      return { color: '#38bdf8' };
    case 'glow':
      return { color: '#fde047' };
    case 'appear':
      return { direction: 'up', distance: 120 };
    case 'rotate':
      return { mode: 'angle', angle: 360, speed: 90, axis: 'y' };
    case 'indicate':
      return { scale: 1.3, color: '#ffff00' };
    case 'circumscribe':
      return { color: '#ffff00' };
    case 'focus':
      return { color: '#888888', opacity: 0.2 };
    case 'colorChange':
      return { fillEnabled: true, targetFillColor: '#ffff00', strokeEnabled: true, targetStrokeColor: '#ffff00' };
    case 'groupTransform':
      return { keepSource: false };
    default:
      return {};
  }
}

/** Fracción máxima del lienzo que ocupa una fórmula recién insertada. */
const FORMULA_MAX_W = 0.75;
const FORMULA_MAX_H = 0.35;

export const actions = {
  reserveObjectId(): string {
    objectSerial = Math.max(objectSerial, state.project.counters.obj) + 1;
    return `o${objectSerial}`;
  },

  setFormat(format: StageFormat) {
    store.setProject((p) => {
      if (p.format === format) return p;
      const a = STAGE_SIZES[p.format];
      const b = STAGE_SIZES[format];
      const dx = (b.w - a.w) / 2;
      const dy = (b.h - a.h) / 2;
      // Conserva la posición relativa al centro del lienzo (cambio reversible).
      const objects = p.objects.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
      return { ...p, format, objects };
    });
  },

  setBackground(background: StageBackground) {
    // El selector clásico sustituye a cualquier plantilla personalizada.
    store.setProject((p) => (p.background === background && !p.sceneBackground ? p : { ...p, background, sceneBackground: undefined }));
  },

  /** Cambia la plantilla de fondo (sólido, cuadrícula con nodos o isométrica con nodos). */
  setSceneBackgroundType(type: SceneBackgroundType) {
    store.setProject((p) => {
      const current = resolveSceneBackground(p);
      if (p.sceneBackground && current.type === type) return p;
      // Al pasar de sólido a retícula se propone el azul noche por defecto; en sólido se conserva el color actual.
      const bgColor = type !== 'solid' && current.type === 'solid' ? GRID_BG_COLOR : current.bgColor;
      return { ...p, sceneBackground: { ...current, type, bgColor } };
    });
  },

  /** Ajusta parámetros de la plantilla de fondo (con `group` se agrupa un arrastre en una sola entrada de historial). */
  setSceneBackground(patch: Partial<Omit<SceneBackground, 'type'>>, group?: symbol) {
    store.setProject((p) => {
      const current = resolveSceneBackground(p);
      const next = normalizeSceneBackground({ ...current, ...patch });
      const same = p.sceneBackground && (Object.keys(next) as (keyof SceneBackground)[]).every((k) => next[k] === current[k]);
      return same ? p : { ...p, sceneBackground: next };
    }, group);
  },

  addObject2D(o: Omit<Obj2D, 'x' | 'y' | 'scale' | 'rotation'> & { fit: number; position?: { x: number; y: number } }) {
    store.setProject((p) => {
      const { w, h } = STAGE_SIZES[p.format];
      const { fit, position, ...rest } = o;
      // Las fórmulas LaTeX nacen ajustadas: nunca más del 75 % del ancho ni del 35 % del alto del formato actual.
      const scale = rest.kind === 'formula' && rest.bw > 0 && rest.bh > 0
        ? Math.min(w * FORMULA_MAX_W / rest.bw, h * FORMULA_MAX_H / rest.bh)
        : fit;
      const obj: Obj2D = { ...rest, x: position?.x ?? w / 2, y: position?.y ?? h / 2, scale, rotation: 0 };
      return { ...p, objects: [...p.objects, obj], counters: { ...p.counters, obj: Math.max(p.counters.obj, Number(o.id.slice(1))) } };
    });
    actions.select(o.id);
  },

  removeObject(id: string) {
    store.setProject((p) => ({
      ...p,
      objects: p.objects.filter((o) => o.id !== id),
      styles: stripNodeKeys(p.styles, id),
      clips: pruneGroupClips(p.clips, new Set([id]))
        .filter((c) => c.targetId !== id && !c.targetId.startsWith(id + '.') && c.parameters.to !== id),
      savedGroups: pruneSavedGroups(p.savedGroups, (entry) => entry !== id),
    }));
    const ui = store.getState().ui;
    const affected = (s: string | null) => s !== null && (s === id || s.startsWith(id + '.'));
    const clipStill = store.getState().project.clips.some((c) => c.id === ui.selectedClip);
    store.setUi({
      selection: affected(ui.selection) ? null : ui.selection,
      multiSelection: keepMulti(ui.multiSelection.filter((entry) => entry !== id)),
      selectedClip: clipStill ? ui.selectedClip : null,
      pendingTransformSourceIds: keepPending(ui.pendingTransformSourceIds, (entry) => entry !== id),
      ...(ui.termEdit === id ? { termEdit: null, glyphSel: [] } : {}),
    });
  },

  addVector(vector: VectorGeometry, bw: number, bh: number, position: { x: number; y: number }) {
    const id = actions.reserveObjectId();
    const sourceSvg = vectorSvg(vector, bw, bh);
    actions.addObject2D({
      id, kind: 'svg', name: VECTOR_LABEL[vector.tool], vector, bw, bh, position, fit: 1,
      sourceSvg, markup: prepareSvg(sourceSvg, id).markup,
    });
  },

  editVector(object: Obj2D, patch: Partial<VectorGeometry>, group?: symbol) {
    if (!object.vector) return;
    const vector = { ...object.vector, ...patch };
    const sourceSvg = vectorSvg(vector, object.bw, object.bh);
    actions.updateObject(object.id, { vector, sourceSvg, markup: prepareSvg(sourceSvg, object.id).markup }, group);
  },

  /**
   * Sustituye los nodos de un trazado Bézier. `base` es el objeto tal como estaba al empezar la edición y `nodes`
   * están en su sistema local: la caja se recalcula para envolver nodos y manejadores, y el centro se desplaza
   * (teniendo en cuenta escala y rotación) para que el trazado no se mueva en el escenario.
   */
  setPathNodes(base: Obj2D, nodes: PathNode[], group?: symbol, patch: Partial<VectorGeometry> = {}) {
    if (!base.vector || !nodes.length) return;
    const box = nodesBounds(nodes);
    const bw = Math.max(1, box.w);
    const bh = Math.max(1, box.h);
    const cx = box.x + bw / 2 - base.bw / 2;
    const cy = box.y + bh / 2 - base.bh / 2;
    const th = (base.rotation * Math.PI) / 180;
    const x = base.x + base.scale * (cx * Math.cos(th) - cy * Math.sin(th));
    const y = base.y + base.scale * (cx * Math.sin(th) + cy * Math.cos(th));
    const vector: VectorGeometry = { ...base.vector, ...patch, nodes: translateNodes(nodes, -box.x, -box.y) };
    const sourceSvg = vectorSvg(vector, bw, bh);
    actions.updateObject(base.id, { x, y, bw, bh, vector, sourceSvg, markup: prepareSvg(sourceSvg, base.id).markup }, group);
  },

  /** Alterna un nodo del trazado entre ángulo (`corner`) y curva suave (`smooth`). */
  togglePathNode(objectId: string, index: number) {
    const object = state.project.objects.find((o) => o.id === objectId);
    const nodes = object?.vector?.nodes;
    if (!object || !nodes?.[index]) return;
    actions.setPathNodes(object, toggleNodeType(nodes, index, !!object.vector?.closed));
  },

  /** Inserta un plano cartesiano estilo Manim `NumberPlane` centrado en el lienzo y lo deja seleccionado. */
  addCartesianPlane(position?: { x: number; y: number }) {
    const id = actions.reserveObjectId();
    const plane = normalizePlane();
    const sourceSvg = planeSvg(plane);
    const n = state.project.objects.filter((o) => o.plane).length + 1;
    actions.addObject2D({
      id, kind: 'svg', name: n === 1 ? 'Plano cartesiano' : `Plano cartesiano ${n}`, plane, bw: plane.width, bh: plane.height,
      position, fit: 1, sourceSvg, markup: prepareSvg(sourceSvg, id).markup,
    });
  },

  /**
   * Edita la geometría de un plano y regenera su SVG (dimensiones incluidas). `extra` permite mover el
   * objeto en la misma entrada de historial (p. ej. al redimensionar desde una esquina).
   */
  editPlane(object: Obj2D, patch: Partial<PlaneGeometry>, group?: symbol, extra?: Partial<SceneObject>) {
    if (!object.plane) return;
    const plane = normalizePlane({ ...object.plane, ...patch });
    const sourceSvg = planeSvg(plane);
    actions.updateObject(object.id, {
      ...extra, plane, sourceSvg, bw: plane.width, bh: plane.height, markup: prepareSvg(sourceSvg, object.id).markup,
    }, group);
  },

  orderObject(id: string, front: boolean) {
    store.setProject((project) => {
      const object = project.objects.find((entry) => entry.id === id);
      if (!object || project.objects[front ? project.objects.length - 1 : 0] === object) return project;
      const remaining = project.objects.filter((entry) => entry.id !== id);
      return { ...project, objects: front ? [...remaining, object] : [object, ...remaining] };
    });
  },

  /** Duplica un objeto (+24 px) y selecciona la copia; ver `duplicateObjects`. */
  duplicateObject(id: string) {
    actions.duplicateObjects([id]);
  },

  /** Duplica la selección actual (uno o varios objetos). Devuelve los ids de las copias. */
  duplicateSelection(): string[] {
    return actions.duplicateObjects(selectedObjectIds(state.ui));
  },

  /**
   * Duplica varios objetos (con estilos, degradados, fórmulas, planos y clips) desplazados `offset` px, en una
   * sola entrada de historial (o en la del gesto `group`), y deja seleccionadas las copias. Devuelve sus ids.
   */
  duplicateObjects(ids: string[], offset = 24, group?: symbol): string[] {
    // En el orden de `ids`: la copia i corresponde a ids[i] (lo usa Alt+arrastrar para mapear posiciones).
    const sources = [...new Set(ids)].map((id) => state.project.objects.find((object) => object.id === id)).filter((o): o is Obj2D => !!o);
    if (!sources.length) return [];
    const pairs = sources.map((object) => ({ object, nextId: actions.reserveObjectId() }));
    store.setProject((project) => {
      const styles = { ...project.styles };
      const objects = [...project.objects];
      const clips = [...project.clips];
      let clip = project.counters.clip;
      for (const { object, nextId } of pairs) {
        const id = object.id;
        objects.push({ ...object, id: nextId, name: `${object.name} (copia)`, x: object.x + offset, y: object.y + offset,
          markup: prepareSvg(object.sourceSvg, nextId).markup });
        for (const [target, style] of Object.entries(project.styles)) {
          if (target === id || target.startsWith(id + '.')) styles[nextId + target.slice(id.length)] = style;
        }
        for (const entry of project.clips) {
          // Las transformaciones de grupo enlazan varios objetos: no se copian al duplicar uno de ellos.
          if (entry.type === 'groupTransform') continue;
          if (entry.targetId === id || entry.targetId.startsWith(id + '.')) {
            clips.push({ ...entry, id: `c${++clip}`, targetId: nextId + entry.targetId.slice(id.length) });
          }
        }
      }
      const obj = Math.max(project.counters.obj, ...pairs.map(({ nextId }) => Number(nextId.slice(1))));
      return { ...project, styles, objects, clips, counters: { obj, clip } };
    }, group);
    const copies = pairs.map(({ nextId }) => nextId);
    actions.selectMany(copies);
    return copies;
  },

  /** Elimina varios objetos (y sus estilos y clips) en una sola acción reversible. */
  removeObjects(ids: string[]) {
    const set = new Set(ids.filter((id) => state.project.objects.some((object) => object.id === id)));
    if (!set.size) return;
    const owned = (target: string) => set.has(target.split('.')[0]);
    store.setProject((p) => ({
      ...p,
      objects: p.objects.filter((o) => !set.has(o.id)),
      styles: Object.fromEntries(Object.entries(p.styles).filter(([key]) => !owned(key))),
      clips: pruneGroupClips(p.clips, set)
        .filter((c) => !owned(c.targetId) && !(typeof c.parameters.to === 'string' && set.has(c.parameters.to))),
      savedGroups: pruneSavedGroups(p.savedGroups, (entry) => !set.has(entry)),
    }));
    const ui = store.getState().ui;
    const clipStill = store.getState().project.clips.some((c) => c.id === ui.selectedClip);
    store.setUi({
      selection: ui.selection && owned(ui.selection) ? null : ui.selection,
      multiSelection: keepMulti(ui.multiSelection.filter((entry) => !set.has(entry))),
      selectedClip: clipStill ? ui.selectedClip : null,
      pendingTransformSourceIds: keepPending(ui.pendingTransformSourceIds, (entry) => !set.has(entry)),
      ...(ui.termEdit && set.has(ui.termEdit) ? { termEdit: null, glyphSel: [] } : {}),
    });
  },

  updateObject(id: string, patch: Partial<SceneObject>, group?: symbol) {
    store.setProject((p) => {
      const object = p.objects.find((entry) => entry.id === id);
      if (!object || Object.entries(patch).every(([key, value]) => Reflect.get(object, key) === value)) return p;
      const updated = { ...object, ...patch } as SceneObject;
      return { ...p, objects: p.objects.map((entry) => entry === object ? updated : entry) };
    }, group);
  },

  /** Aplica un estilo. Un valor `undefined` elimina el override de esa propiedad. */
  setStyle(nodeId: string, patch: Partial<NodeStyle>, group?: symbol) {
    store.setProject((p) => {
      const previous = p.styles[nodeId] ?? {};
      if (Object.entries(patch).every(([key, value]) => Reflect.get(previous, key) === value)) return p;
      const cur: NodeStyle = { ...previous };
      for (const k of Object.keys(patch) as (keyof NodeStyle)[]) {
        const v = patch[k];
        if (v === undefined) delete cur[k];
        else (cur as Record<string, unknown>)[k] = v;
      }
      const styles = { ...p.styles };
      if (Object.keys(cur).length === 0) delete styles[nodeId];
      else styles[nodeId] = cur;
      return { ...p, styles };
    }, group);
  },

  addClip(args: {
    targetId: string;
    type: ClipType;
    start: number;
    duration: number;
    parameters?: ClipParams;
    sound?: SoundId | null;
  }): string {
    let id = '';
    store.setProject((p) => {
      id = `c${p.counters.clip + 1}`;
      const clip: Clip = {
        id,
        targetId: args.targetId,
        type: args.type,
        start: Math.max(0, r2(args.start)),
        duration: Math.max(0.05, r2(args.duration)),
        parameters: { ...defaultClipParams(args.type), ...(args.parameters ?? {}) },
        sound: args.sound ?? null,
      };
      return { ...p, clips: [...p.clips, clip], counters: { ...p.counters, clip: p.counters.clip + 1 } };
    });
    store.setUi({ selectedClip: id });
    return id;
  },

  updateClip(id: string, patch: Partial<Pick<Clip, 'start' | 'duration' | 'sound' | 'parameters'>>, group?: symbol) {
    store.setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        next.start = Math.max(0, r2(next.start));
        next.duration = Math.max(0.05, r2(next.duration));
        return next;
      }),
    }), group);
  },

  /** Paso 1 de la «Transformación de Grupo»: fija los objetos indicados como grupo origen (o lo cancela con `null`). */
  setPendingTransformSource(ids: string[] | null) {
    const existing = ids?.filter((id, i) => ids.indexOf(id) === i && state.project.objects.some((object) => object.id === id)) ?? [];
    store.setUi({ pendingTransformSourceIds: existing.length ? existing : null });
  },

  /**
   * Crea el clip `groupTransform` de `sourceIds` hacia `targetIds` (una sola acción reversible): desde el grupo
   * origen pendiente (paso 2) o directamente desde dos grupos guardados. Los objetos que estén en ambos grupos se
   * quitan del destino. Devuelve el id del clip, o `null` si no es válido.
   */
  addGroupTransform(
    sourceIds: string[], targetIds: string[], options: { start: number; duration?: number; keepSource?: boolean },
  ): string | null {
    const sources = sourceIds.filter((id, i) => sourceIds.indexOf(id) === i && state.project.objects.some((object) => object.id === id));
    const targets = targetIds.filter((id, i) => targetIds.indexOf(id) === i && !sources.includes(id)
      && state.project.objects.some((object) => object.id === id));
    if (!sources.length || !targets.length) return null;
    const id = actions.addClip({
      targetId: sources[0],
      type: 'groupTransform',
      start: options.start,
      duration: options.duration ?? 2,
      parameters: groupTransformParams({ sourceObjectIds: sources, targetObjectIds: targets, keepSource: options.keepSource === true }),
    });
    return id;
  },

  // ---------------------------------------------------------------- grupos guardados con etiqueta

  /**
   * Guarda los objetos seleccionados bajo una etiqueta (una sola acción reversible). Si ya existe un grupo con
   * ese nombre (sin distinguir mayúsculas), se actualizan sus miembros. Devuelve el id del grupo, o `null`.
   */
  saveSelectionAsGroup(name: string): string | null {
    const ids = selectedObjectIds(state.ui).filter((id) => state.project.objects.some((object) => object.id === id));
    if (!ids.length) return null;
    const groups = state.project.savedGroups ?? [];
    const label = name.trim().slice(0, SAVED_GROUP_NAME_MAX) || `Grupo ${groups.length + 1}`;
    const existing = groups.find((group) => group.name.toLocaleLowerCase() === label.toLocaleLowerCase());
    const id = existing?.id ?? `g${groups.reduce((max, group) => Math.max(max, Number(group.id.slice(1)) || 0), 0) + 1}`;
    const next: SavedGroup = { id, name: label, objectIds: ids };
    store.setProject((p) => ({
      ...p,
      savedGroups: existing
        ? (p.savedGroups ?? []).map((group) => (group.id === id ? next : group))
        : [...(p.savedGroups ?? []), next],
    }));
    return id;
  },

  /** Selecciona en el lienzo todos los objetos vigentes del grupo guardado (no modifica el proyecto). */
  selectSavedGroup(groupId: string) {
    const group = state.project.savedGroups?.find((entry) => entry.id === groupId);
    if (!group) return;
    actions.selectMany(group.objectIds.filter((id) => state.project.objects.some((object) => object.id === id)));
  },

  renameSavedGroup(groupId: string, name: string) {
    const label = name.trim().slice(0, SAVED_GROUP_NAME_MAX);
    if (!label) return;
    store.setProject((p) => {
      const group = p.savedGroups?.find((entry) => entry.id === groupId);
      if (!group || group.name === label) return p;
      return { ...p, savedGroups: p.savedGroups!.map((entry) => (entry.id === groupId ? { ...entry, name: label } : entry)) };
    });
  },

  /** Elimina solo la etiqueta: los objetos del lienzo se conservan. */
  deleteSavedGroup(groupId: string) {
    store.setProject((p) => {
      if (!p.savedGroups?.some((entry) => entry.id === groupId)) return p;
      const savedGroups = p.savedGroups.filter((entry) => entry.id !== groupId);
      return { ...p, savedGroups: savedGroups.length ? savedGroups : undefined };
    });
  },

  removeClip(id: string) {
    store.setProject((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }));
    if (store.getState().ui.selectedClip === id) store.setUi({ selectedClip: null });
  },

  setVoice(v: VoiceMeta | null) {
    store.setProject((p) => ({ ...p, voice: v }));
  },

  updateVoice(patch: Partial<VoiceMeta>, group?: symbol) {
    store.setProject((p) => (p.voice ? { ...p, voice: { ...p.voice, ...patch } } : p), group);
  },

  select(id: string | null) {
    const { termEdit } = store.getState().ui;
    store.setUi({
      selection: id,
      multiSelection: NO_MULTI,
      selectedClip: null,
      ...(termEdit && id?.split('.')[0] !== termEdit ? { termEdit: null, glyphSel: [] } : {}),
    });
  },

  /** Selecciona varios objetos raíz a la vez (marquesina). El último es el principal del inspector. */
  selectMany(ids: string[]) {
    const unique = [...new Set(ids)].filter((id) => state.project.objects.some((object) => object.id === id));
    if (unique.length <= 1) {
      actions.select(unique[0] ?? null);
      return;
    }
    const current = state.ui.multiSelection;
    const same = current.length === unique.length && unique.every((id, i) => id === current[i]);
    store.setUi({
      selection: unique[unique.length - 1],
      multiSelection: same ? current : unique,
      selectedClip: null,
      ...(state.ui.termEdit ? { termEdit: null, glyphSel: [] } : {}),
    });
  },

  /** Mayús+clic: suma el objeto a la selección o lo quita si ya estaba. */
  toggleSelection(objectId: string) {
    const current = selectedObjectIds(state.ui);
    actions.selectMany(current.includes(objectId) ? current.filter((id) => id !== objectId) : [...current, objectId]);
  },

  /**
   * Traslada varios objetos a la vez conservando sus distancias relativas, en una sola entrada de historial.
   * `origins` fija la posición de partida de cada uno (arrastre); sin ella, se suma al valor actual (flechas).
   */
  translateObjects(ids: string[], dx: number, dy: number, group?: symbol, origins?: Record<string, { x: number; y: number }>) {
    if (!ids.length) return;
    const set = new Set(ids);
    store.setProject((p) => {
      let changed = false;
      const objects = p.objects.map((object) => {
        if (!set.has(object.id)) return object;
        const from = origins?.[object.id] ?? object;
        const x = from.x + dx;
        const y = from.y + dy;
        if (x === object.x && y === object.y) return object;
        changed = true;
        return { ...object, x, y };
      });
      return changed ? { ...p, objects } : p;
    }, group);
  },

  /**
   * Desplaza varios objetos raíz en una sola entrada de historial. `offsets` = desplazamiento (px del escenario)
   * de cada objeto; los nulos se ignoran.
   */
  shiftObjects(offsets: Record<string, Vertex>) {
    store.setProject((p) => {
      let changed = false;
      const objects = p.objects.map((object) => {
        const off = offsets[object.id];
        if (!off || (Math.abs(off.x) < 0.005 && Math.abs(off.y) < 0.005)) return object;
        changed = true;
        return { ...object, x: r2(object.x + off.x), y: r2(object.y + off.y) };
      });
      return changed ? { ...p, objects } : p;
    });
  },

  /**
   * Alinea objetos según sus cajas en el escenario (`boxes`, en px lógicos). Con un único objeto, o con
   * `toStage`, la referencia es el propio escenario; si no, la caja envolvente de la selección.
   */
  alignObjects(boxes: Record<string, Box>, mode: AlignMode, toStage = false) {
    const ids = Object.keys(boxes).filter((id) => state.project.objects.some((object) => object.id === id));
    if (!ids.length) return;
    let ref: Box;
    if (toStage || ids.length === 1) {
      const { w, h } = STAGE_SIZES[state.project.format];
      ref = { x: 0, y: 0, w, h };
    } else {
      const x1 = Math.min(...ids.map((id) => boxes[id].x));
      const y1 = Math.min(...ids.map((id) => boxes[id].y));
      const x2 = Math.max(...ids.map((id) => boxes[id].x + boxes[id].w));
      const y2 = Math.max(...ids.map((id) => boxes[id].y + boxes[id].h));
      ref = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    const offsets: Record<string, Vertex> = {};
    for (const id of ids) {
      const b = boxes[id];
      let dx = 0;
      let dy = 0;
      if (mode === 'left') dx = ref.x - b.x;
      else if (mode === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      else if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
      else if (mode === 'top') dy = ref.y - b.y;
      else if (mode === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      else dy = ref.y + ref.h - (b.y + b.h);
      offsets[id] = { x: dx, y: dy };
    }
    actions.shiftObjects(offsets);
  },

  /**
   * Distribuye 3 o más objetos con espaciado idéntico entre sus cajas a lo largo de `axis`: los extremos quedan
   * fijos y los huecos intermedios se igualan (ideal para columnas de ecuaciones).
   */
  distributeObjects(boxes: Record<string, Box>, axis: 'x' | 'y') {
    const ids = Object.keys(boxes).filter((id) => state.project.objects.some((object) => object.id === id));
    if (ids.length < 3) return;
    const start = (b: Box) => (axis === 'x' ? b.x : b.y);
    const size = (b: Box) => (axis === 'x' ? b.w : b.h);
    const sorted = [...ids].sort((a, b) => start(boxes[a]) + size(boxes[a]) / 2 - (start(boxes[b]) + size(boxes[b]) / 2));
    const first = boxes[sorted[0]];
    const last = boxes[sorted[sorted.length - 1]];
    const span = start(last) + size(last) - start(first);
    const total = sorted.reduce((sum, id) => sum + size(boxes[id]), 0);
    const gap = (span - total) / (sorted.length - 1);
    const offsets: Record<string, Vertex> = {};
    let cursor = start(first);
    for (const id of sorted) {
      const d = cursor - start(boxes[id]);
      offsets[id] = axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d };
      cursor += size(boxes[id]) + gap;
    }
    actions.shiftObjects(offsets);
  },

  /** Entra en el modo de edición de términos de una fórmula. */
  enterTermEdit(objectId: string) {
    store.setUi({ selection: objectId, multiSelection: NO_MULTI, selectedClip: null, termEdit: objectId, glyphSel: [] });
  },

  exitTermEdit() {
    store.setUi({ termEdit: null, glyphSel: [] });
  },

  selectGlyphs(indices: number[]) {
    const next = [...new Set(indices)].sort((a, b) => a - b);
    const current = store.getState().ui.glyphSel;
    if (next.length === current.length && next.every((value, i) => value === current[i])) return;
    store.setUi({ glyphSel: next });
  },

  /** Aplica propiedades a varios glifos de una fórmula. `undefined` elimina el override. */
  setGlyphStyle(objectId: string, indices: number[], patch: Partial<GlyphStyle>, group?: symbol) {
    store.setProject((p) => {
      const object = p.objects.find((entry) => entry.id === objectId);
      if (!object || !indices.length) return p;
      const styles = { ...object.glyphStyles };
      for (const index of indices) {
        const cur: GlyphStyle = { ...styles[index] };
        for (const key of Object.keys(patch) as (keyof GlyphStyle)[]) {
          const value = patch[key];
          if (value === undefined) delete cur[key];
          else (cur as Record<string, unknown>)[key] = value;
        }
        if (Object.keys(cur).length) styles[index] = cur;
        else delete styles[index];
      }
      const before = object.glyphStyles ?? {};
      const same = Object.keys(styles).length === Object.keys(before).length &&
        Object.entries(styles).every(([key, value]) => JSON.stringify(before[key]) === JSON.stringify(value));
      if (same) return p;
      const updated: Obj2D = { ...object, glyphStyles: Object.keys(styles).length ? styles : undefined };
      return { ...p, objects: p.objects.map((entry) => entry === object ? updated : entry) };
    }, group);
  },

  /** Guarda la selección de glifos como término con nombre. Devuelve su id. */
  saveTerm(objectId: string, name: string, indices: number[]): string | null {
    const label = name.trim().slice(0, 60);
    if (!label || !indices.length) return null;
    let id: string | null = null;
    store.setProject((p) => {
      const object = p.objects.find((entry) => entry.id === objectId);
      if (!object) return p;
      const terms = object.terms ?? [];
      id = `t${terms.reduce((max, term) => Math.max(max, Number(term.id.slice(1))), 0) + 1}`;
      const updated: Obj2D = { ...object, terms: [...terms, { id, name: label, glyphs: [...new Set(indices)].sort((a, b) => a - b) }] };
      return { ...p, objects: p.objects.map((entry) => entry === object ? updated : entry) };
    });
    return id;
  },

  removeTerm(objectId: string, termId: string) {
    store.setProject((p) => {
      const object = p.objects.find((entry) => entry.id === objectId);
      if (!object || !object.terms?.some((term) => term.id === termId)) return p;
      const terms = object.terms.filter((term) => term.id !== termId);
      const updated: Obj2D = { ...object, terms: terms.length ? terms : undefined };
      return { ...p, objects: p.objects.map((entry) => entry === object ? updated : entry) };
    });
  },

  notify(kind: 'error' | 'info', text: string) {
    store.setUi({ notice: { kind, text } });
  },
};
