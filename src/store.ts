import { History } from './engine/history';
import { prepareSvg } from './engine/svgImport';
import { VECTOR_LABEL, vectorSvg } from './engine/vector';
import { useSyncExternalStore } from 'react';
import {
  STAGE_SIZES,
  is2D,
  type CameraState,
  type Clip,
  type ClipParams,
  type ClipType,
  type NodeStyle,
  type Obj2D,
  type Project,
  type Shape3D,
  type SoundId,
  type SceneObject,
  type StageBackground,
  type StageFormat,
  type VoiceMeta,
  type VectorGeometry,
  type VectorTool,
  SHAPE3D_LABEL,
} from './types';

export type RecordingPhase = 'idle' | 'picker' | 'preparing' | 'recording' | 'finishing';

export interface RecordingState {
  phase: RecordingPhase;
  message: string | null;
  captureSize: { w: number; h: number } | null;
  lastFile: { url: string; name: string; size: number; mime: string } | null;
}

export interface UIState {
  selection: string | null;
  selectedClip: string | null;
  time: number;
  playing: boolean;
  speed: 0.5 | 1 | 1.5;
  cameraMode: boolean;
  vectorTool: VectorTool | null;
  vectorText: string;
  showGuides: boolean;
  recordQuality: 'light' | 'standard';
  recording: RecordingState;
  notice: { kind: 'error' | 'info'; text: string } | null;
  webgl: 'idle' | 'loading' | 'ready' | 'unavailable';
  webglMessage: string | null;
  /** Se incrementa cuando cambia el árbol de nodos SVG montado. */
  treeVersion: number;
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
    camera: { az: 35, el: 22, dist: 9 },
    voice: null,
    counters: { obj: 0, clip: 0 },
  };
}

function defaultUI(): UIState {
  return {
    selection: null,
    selectedClip: null,
    time: 0,
    playing: false,
    speed: 1,
    cameraMode: false,
    vectorTool: null,
    vectorText: 'Texto',
    showGuides: true,
    recordQuality: 'light',
    recording: { phase: 'idle', message: null, captureSize: null, lastFile: null },
    notice: null,
    webgl: 'idle',
    webglMessage: null,
    treeVersion: 0,
  };
}

let state: State = { project: defaultProject(), ui: defaultUI() };
const listeners = new Set<() => void>();

let projectGeneration = 0;
let objectSerial = 0;
let history = new History<Project>();

function restoreHistory(direction: 'undo' | 'redo') {
  const project = history[direction](state.project);
  if (!project) return;
  const { selection, selectedClip } = state.ui;
  state = {
    project,
    ui: {
      ...state.ui,
      selection: project.objects.some((object) => object.id === selection?.split('.')[0]) ? selection : null,
      selectedClip: project.clips.some((clip) => clip.id === selectedClip) ? selectedClip : null,
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
        ...state.ui, selection: null, selectedClip: null, time: 0,
        playing: false, cameraMode: false, vectorTool: null, notice: null,
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
    case 'orbit':
      return { angle: 180 };
    default:
      return {};
  }
}

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
      const objects = p.objects.map((o) => (is2D(o) ? { ...o, x: o.x + dx, y: o.y + dy } : o));
      return { ...p, format, objects };
    });
  },

  setBackground(background: StageBackground) {
    store.setProject((p) => (p.background === background ? p : { ...p, background }));
  },

  addObject2D(o: Omit<Obj2D, 'x' | 'y' | 'scale' | 'rotation'> & { fit: number; position?: { x: number; y: number } }) {
    store.setProject((p) => {
      const { w, h } = STAGE_SIZES[p.format];
      const { fit, position, ...rest } = o;
      const obj: Obj2D = { ...rest, x: position?.x ?? w / 2, y: position?.y ?? h / 2, scale: fit, rotation: 0 };
      return { ...p, objects: [...p.objects, obj], counters: { ...p.counters, obj: Math.max(p.counters.obj, Number(o.id.slice(1))) } };
    });
    actions.select(o.id);
  },

  add3D(shape: Shape3D) {
    const id = actions.reserveObjectId();
    store.setProject((p) => ({
      ...p,
      counters: { ...p.counters, obj: Number(id.slice(1)) },
      objects: [...p.objects, { id, kind: 'shape3d', name: SHAPE3D_LABEL[shape], shape, scale: 1, rotation: 0 }],
    }));
    actions.select(id);
  },

  removeObject(id: string) {
    store.setProject((p) => ({
      ...p,
      objects: p.objects.filter((o) => o.id !== id),
      styles: stripNodeKeys(p.styles, id),
      clips: p.clips.filter((c) => c.targetId !== id && !c.targetId.startsWith(id + '.')),
    }));
    const ui = store.getState().ui;
    const affected = (s: string | null) => s !== null && (s === id || s.startsWith(id + '.'));
    const clipStill = store.getState().project.clips.some((c) => c.id === ui.selectedClip);
    store.setUi({
      selection: affected(ui.selection) ? null : ui.selection,
      selectedClip: clipStill ? ui.selectedClip : null,
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

  editVector(object: Obj2D, patch: Partial<VectorGeometry>) {
    if (!object.vector) return;
    const vector = { ...object.vector, ...patch };
    const sourceSvg = vectorSvg(vector, object.bw, object.bh);
    actions.updateObject(object.id, { vector, sourceSvg, markup: prepareSvg(sourceSvg, object.id).markup });
  },

  orderObject(id: string, front: boolean) {
    store.setProject((project) => {
      const object = project.objects.find((entry) => entry.id === id);
      if (!object || project.objects[front ? project.objects.length - 1 : 0] === object) return project;
      const remaining = project.objects.filter((entry) => entry.id !== id);
      return { ...project, objects: front ? [...remaining, object] : [object, ...remaining] };
    });
  },

  duplicateObject(id: string) {
    const object = state.project.objects.find((entry) => entry.id === id);
    if (!object) return;
    const nextId = actions.reserveObjectId();
    const base = { id: nextId, name: `${object.name} (copia)` };
    const copy = is2D(object)
      ? { ...object, ...base, x: object.x + 20, y: object.y + 20, markup: prepareSvg(object.sourceSvg, nextId).markup }
      : { ...object, ...base };
    store.setProject((project) => {
      const styles = { ...project.styles };
      for (const [target, style] of Object.entries(project.styles)) {
        if (target === id || target.startsWith(id + '.')) styles[nextId + target.slice(id.length)] = style;
      }
      let clip = project.counters.clip;
      const copies = project.clips
        .filter((entry) => entry.targetId === id || entry.targetId.startsWith(id + '.'))
        .map((entry) => ({ ...entry, id: `c${++clip}`, targetId: nextId + entry.targetId.slice(id.length) }));
      return { ...project, styles, objects: [...project.objects, copy],
        clips: [...project.clips, ...copies], counters: { obj: Number(nextId.slice(1)), clip } };
    });
    actions.select(nextId);
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

  setCamera(patch: Partial<CameraState>, group?: symbol) {
    store.setProject((p) => ({ ...p, camera: { ...p.camera, ...patch } }), group);
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
    store.setUi({ selection: id, selectedClip: null });
  },

  notify(kind: 'error' | 'info', text: string) {
    store.setUi({ notice: { kind, text } });
  },
};
