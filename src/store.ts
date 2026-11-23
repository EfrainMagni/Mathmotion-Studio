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

export const store = {
  getState: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  setProject(fn: (p: Project) => Project) {
    const next = fn(state.project);
    if (next === state.project) return;
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
  /** Sustituye el proyecto completo (vista de grabación). */
  replaceProject(p: Project) {
    state = { ...state, project: p };
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
    let id = '';
    store.setProject((p) => {
      id = `o${p.counters.obj + 1}`;
      return { ...p, counters: { ...p.counters, obj: p.counters.obj + 1 } };
    });
    return id;
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

  addObject2D(o: Omit<Obj2D, 'x' | 'y' | 'scale' | 'rotation'> & { fit: number }) {
    store.setProject((p) => {
      const { w, h } = STAGE_SIZES[p.format];
      const { fit, ...rest } = o;
      const obj: Obj2D = { ...rest, x: w / 2, y: h / 2, scale: fit, rotation: 0 };
      return { ...p, objects: [...p.objects, obj] };
    });
    store.setUi({ selection: o.id });
  },

  add3D(shape: Shape3D) {
    const id = actions.reserveObjectId();
    store.setProject((p) => ({
      ...p,
      objects: [...p.objects, { id, kind: 'shape3d', name: SHAPE3D_LABEL[shape], shape, scale: 1, rotation: 0 }],
    }));
    store.setUi({ selection: id });
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

  updateObject(id: string, patch: Partial<SceneObject>) {
    store.setProject((p) => ({
      ...p,
      objects: p.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as SceneObject) : o)),
    }));
  },

  /** Aplica un estilo. Un valor `undefined` elimina el override de esa propiedad. */
  setStyle(nodeId: string, patch: Partial<NodeStyle>) {
    store.setProject((p) => {
      const cur: NodeStyle = { ...(p.styles[nodeId] ?? {}) };
      for (const k of Object.keys(patch) as (keyof NodeStyle)[]) {
        const v = patch[k];
        if (v === undefined) delete cur[k];
        else (cur as Record<string, unknown>)[k] = v;
      }
      const styles = { ...p.styles };
      if (Object.keys(cur).length === 0) delete styles[nodeId];
      else styles[nodeId] = cur;
      return { ...p, styles };
    });
  },

  setCamera(patch: Partial<CameraState>) {
    store.setProject((p) => ({ ...p, camera: { ...p.camera, ...patch } }));
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

  updateClip(id: string, patch: Partial<Pick<Clip, 'start' | 'duration' | 'sound' | 'parameters'>>) {
    store.setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        next.start = Math.max(0, r2(next.start));
        next.duration = Math.max(0.05, r2(next.duration));
        return next;
      }),
    }));
  },

  removeClip(id: string) {
    store.setProject((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }));
    if (store.getState().ui.selectedClip === id) store.setUi({ selectedClip: null });
  },

  setVoice(v: VoiceMeta | null) {
    store.setProject((p) => ({ ...p, voice: v }));
  },

  updateVoice(patch: Partial<VoiceMeta>) {
    store.setProject((p) => (p.voice ? { ...p, voice: { ...p.voice, ...patch } } : p));
  },

  select(id: string | null) {
    store.setUi({ selection: id });
  },

  notify(kind: 'error' | 'info', text: string) {
    store.setUi({ notice: { kind, text } });
  },
};
