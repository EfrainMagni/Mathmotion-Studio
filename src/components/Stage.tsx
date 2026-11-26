import { regularPolygon, vectorSvg } from '../engine/vector';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import {
  SCENE_GRID_LINE_WIDTH, STAGE_SIZES, resolveSceneBackground, sceneBackgroundGeometry, sceneBackgroundTile,
  type Box, type SceneBackground, type Obj2D, type VectorGeometry, type Vertex } from '../types';
import { actions, selectedObjectIds, store, useStore } from '../store';
import { audio, engine } from '../engine';
import { SceneRuntime } from '../engine/runtime';
import { Playback } from '../engine/playback';
import { PolygonOptions } from './PolygonOptions';

type Drag =
  | { kind: 'root'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'child'; id: string; sx: number; sy: number; ox: number; oy: number; inv: DOMMatrix }
  | { kind: 'resize'; id: string; sx: 1 | -1; sy: 1 | -1; anchor: Vertex }
  | { kind: 'group'; ids: string[]; sx: number; sy: number; origins: Record<string, Vertex>; copyOnMove?: boolean }
  | { kind: 'marquee'; start: Vertex; base: string[] }
  | { kind: 'vertex'; id: string; native: Obj2D | null; index: number; points: Vertex[]; start: Vertex; inverse: DOMMatrix; matrix: DOMMatrix; linear: boolean };

type Sketch = { start: Vertex; end: Vertex; vector: VectorGeometry; constrain: boolean; polygonSides: number };

const NO_BOXES: (Box | null)[] = [];
const DOUBLE_CLICK_MS = 400;
/** Color de la marquesina de selección (azul Manim). */
const MARQUEE_COLOR = '#58C4DD';

/** Ids de los objetos cuya caja toca o queda dentro del rectángulo `a`–`b` (coordenadas lógicas). */
function objectsInMarquee(rt: SceneRuntime, ids: string[], a: Vertex, b: Vertex): string[] {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return ids.filter((id) => {
    const box = rt.getBox(id);
    return !!box && box.x <= x2 && box.x + box.w >= x1 && box.y <= y2 && box.y + box.h >= y1;
  });
}

/** Objetos raíz que la escena dibuja (los ocultos por `display: none` no tienen caja). */
function visibleObjectIds(rt: SceneRuntime): string[] {
  return store.getState().project.objects.map((object) => object.id).filter((id) => {
    const box = rt.getBox(id);
    return !!box && (box.w > 0 || box.h > 0);
  });
}

function sameBoxes(a: (Box | null)[], b: (Box | null)[]) {
  return a.length === b.length && a.every((box, i) => {
    const other = b[i];
    if (!box || !other) return box === other;
    return Math.abs(box.x - other.x) < 0.1 && Math.abs(box.y - other.y) < 0.1 && Math.abs(box.w - other.w) < 0.1 && Math.abs(box.h - other.h) < 0.1;
  });
}

function transformVertex(matrix: DOMMatrix, x: number, y: number): Vertex {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function sketchBounds({ start, end, vector, constrain, polygonSides }: Sketch) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (vector.tool === 'polygon') {
    const radius = Math.hypot(dx, dy);
    return radius >= 1 ? regularPolygon(start, radius, polygonSides, Math.atan2(dy, dx)) : null;
  }
  let bw = Math.abs(dx);
  let bh = Math.abs(dy);
  if (constrain && (vector.tool === 'ellipse' || vector.tool === 'rectangle')) {
    bw = bh = Math.min(bw, bh);
  }
  const click = bw < 3 && bh < 3;
  if (click && vector.tool !== 'text') return null;
  if (vector.tool === 'text' && !vector.text?.trim()) return null;
  if (click) {
    bw = Math.max(80, (vector.text?.length ?? 0) * 24);
    bh = 48;
  }
  bw = Math.max(1, bw);
  bh = Math.max(1, bh);
  const x = start.x - (dx < 0 && !click ? bw : 0);
  const y = start.y - (dy < 0 && !click ? bh : 0);
  return { x, y, bw, bh, vector: { ...vector, reverseX: dx < 0, reverseY: dy < 0 } };
}

/**
 * Plantilla de fondo vectorial: un `<pattern>` (cuadrícula o retícula isométrica con nodos) sobre el color base.
 * Un nodo coincide siempre con el centro del escenario; la tesela contiene sus bordes completos, de modo
 * que las líneas y círculos recortados se completan con los de las teselas vecinas.
 */
export function SceneBackdrop({ bg, width, height }: { bg: SceneBackground; width: number; height: number }) {
  if (bg.type === 'solid') return null;
  const { tw, th } = sceneBackgroundTile(bg);
  const { lines, dots } = sceneBackgroundGeometry(bg, 0, 0, 0, 0, tw, th);
  const id = `mm-scene-bg-${bg.type}`;
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" x={width / 2} y={height / 2} width={tw} height={th}>
          <g opacity={bg.opacity}>
            <g stroke={bg.lineColor} strokeWidth={SCENE_GRID_LINE_WIDTH} fill="none">
              {lines.map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />)}
            </g>
            {bg.dotRadius > 0 && (
              <g fill={bg.lineColor}>
                {dots.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={bg.dotRadius} />)}
              </g>
            )}
          </g>
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${id})`} />
    </svg>
  );
}

/** Escenario del editor: capas de fondo, SVG, efectos y marcas de interfaz. */
export function Stage({ viewportScale }: { viewportScale: number }) {
  const format = useStore((s) => s.project.format);
  const background = useStore((s) => s.project.background);
  const sceneBackground = useStore((s) => s.project.sceneBackground);
  const playing = useStore((s) => s.ui.playing);
  const recPhase = useStore((s) => s.ui.recording.phase);
  const vectorTool = useStore((s) => s.ui.vectorTool);
  const direct = useStore((s) => s.ui.pointerTool === 'direct');
  const anchorsEnabled = useStore((s) => !!s.ui.selection && !s.ui.multiSelection.length && !s.ui.vectorTool && !s.ui.termEdit &&
    !s.ui.playing && s.ui.recording.phase === 'idle' && s.ui.pointerTool !== 'hand');
  const anchorProject = useStore((s) => anchorsEnabled ? s.project : null);
  const treeVersion = useStore((s) => anchorsEnabled ? s.ui.treeVersion : 0);
  const time = useStore((s) => anchorsEnabled ? s.ui.time : 0);
  const showGuides = useStore((s) => s.ui.showGuides);
  const selection = useStore((s) => s.ui.selection);
  const multiSelection = useStore((s) => s.ui.multiSelection);
  const termEdit = useStore((s) => s.ui.termEdit);
  const glyphSel = useStore((s) => s.ui.glyphSel);
  const selectedPlane = useStore((s) => {
    const id = s.ui.selection;
    return id && !id.includes('.') ? s.project.objects.find((o) => o.id === id && o.plane) ?? null : null;
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const pointer = useRef<{ id: number; generation: number; group: symbol } | null>(null);
  const draft = useRef<Sketch | null>(null);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [anchors, setAnchors] = useState<Vertex[]>([]);
  const [activeAnchor, setActiveAnchor] = useState<number | null>(null);
  const [k, setK] = useState(0.4);
  const [box, setBox] = useState<Box | null>(null);
  const [glyphBoxes, setGlyphBoxes] = useState<(Box | null)[]>(NO_BOXES);
  const [multiBoxes, setMultiBoxes] = useState<(Box | null)[]>(NO_BOXES);
  const [marquee, setMarquee] = useState<{ a: Vertex; b: Vertex } | null>(null);
  const lastClick = useRef<{ id: string; t: number } | null>(null);

  const { w: W, h: H } = STAGE_SIZES[format];
  const hideUi = playing || recPhase === 'recording' || recPhase === 'preparing' || recPhase === 'finishing';

  // Runtime y línea de tiempo maestra: se crean una vez y se liberan al desmontar.
  useEffect(() => {
    const rt = new SceneRuntime(
      { stage: stageRef.current!, layer: layerRef.current!, fx: fxRef.current! },
      {
        onTree: () => store.setUi({ treeVersion: store.getState().ui.treeVersion + 1 }),
      },
    );
    const pb = new Playback(rt, audio, {
      getProject: () => store.getState().project,
      onTime: (t) => store.setUi({ time: t }),
      onPlaying: (p) => store.setUi({ playing: p }),
    });
    engine.runtime = rt;
    engine.playback = pb;

    let lastProject = store.getState().project;
    let lastClips = lastProject.clips;
    let lastVoice = lastProject.voice;
    rt.setProject(lastProject);
    pb.rebuild(lastProject);

    const updateBox = () => {
      const s = store.getState();
      const glyphs = s.ui.termEdit && !s.ui.playing ? rt.getGlyphBoxes(s.ui.termEdit) : NO_BOXES;
      setGlyphBoxes((prev) => (sameBoxes(prev, glyphs) ? prev : glyphs));
      const many = !s.ui.playing && s.ui.multiSelection.length ? s.ui.multiSelection.map((id) => rt.getBox(id)) : NO_BOXES;
      setMultiBoxes((prev) => (sameBoxes(prev, many) ? prev : many));
      if (s.ui.playing || !s.ui.selection) {
        setBox((b) => (b === null ? b : null));
        return;
      }
      const b = rt.getBox(s.ui.selection);
      setBox((prev) => {
        if (!b) return prev === null ? prev : null;
        if (prev && Math.abs(prev.x - b.x) < 0.1 && Math.abs(prev.y - b.y) < 0.1 && Math.abs(prev.w - b.w) < 0.1 && Math.abs(prev.h - b.h) < 0.1) return prev;
        return b;
      });
    };

    const unsub = store.subscribe(() => {
      const p = store.getState().project;
      if (p !== lastProject) {
        lastProject = p;
        rt.setProject(p);
        if (p.clips !== lastClips || p.voice !== lastVoice) {
          lastClips = p.clips;
          lastVoice = p.voice;
          pb.rebuild(p);
        }
      }
      updateBox();
    });
    updateBox();
    return () => {
      unsub();
      pb.dispose();
      rt.dispose();
      engine.runtime = null;
      engine.playback = null;
    };
  }, []);

  // Flechas con selección múltiple: mueven todo el grupo (1 px, o 10 px con Mayús) como una sola acción.
  // Se escucha en fase de captura y se marca `preventDefault`, de modo que el atajo de objeto único no actúa.
  useEffect(() => {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const onKey = (event: KeyboardEvent) => {
      const direction = arrows[event.key];
      if (!direction || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        document.querySelector('dialog[open]') ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) return;
      const { ui } = store.getState();
      if (ui.multiSelection.length < 2 || ui.selectedClip || ui.playing || ui.termEdit || ui.recording.phase !== 'idle') return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      actions.translateObjects(ui.multiSelection, direction[0] * step, direction[1] * step);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Ajuste del lienzo al espacio disponible conservando la proporción.
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const fit = () => {
      const pad = 24;
      const nk = Math.max(0.05, Math.min((el.clientWidth - pad) / W, (el.clientHeight - pad) / H));
      setK(nk);
      engine.runtime?.setScale(nk);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  useLayoutEffect(() => {
    const target = anchorsEnabled && selection ? engine.runtime?.getVertexTarget(selection, !direct) : null;
    if (!target) {
      setAnchors((previous) => previous.length ? [] : previous);
      return;
    }
    const rect = stageRef.current!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setAnchors(target.points.map(({ x, y }) => {
      const client = transformVertex(target.matrix, x, y);
      return { x: (client.x - rect.left) * W / rect.width, y: (client.y - rect.top) * H / rect.height };
    }));
  }, [direct, anchorsEnabled, selection, anchorProject, treeVersion, time, W, H, k, viewportScale]);

  useEffect(() => setActiveAnchor(null), [selection, direct]);

  function position(event: PointerEvent): Vertex {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(W, Math.max(0, (event.clientX - rect.left) * W / rect.width)),
      y: Math.min(H, Math.max(0, (event.clientY - rect.top) * H / rect.height)),
    };
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const { ui, project } = store.getState();
    if (pointer.current || e.button !== 0 || ui.playing || ui.recording.phase !== 'idle') return;
    const rt = engine.runtime;
    if (!rt) return;
    e.preventDefault();
    const element = e.currentTarget as HTMLElement;
    element.focus({ preventScroll: true });
    element.setPointerCapture(e.pointerId);
    pointer.current = { id: e.pointerId, generation: store.projectGeneration(), group: Symbol() };

    if (ui.vectorTool) {
      const start = position(e);
      const vector: VectorGeometry = { tool: ui.vectorTool };
      if (vector.tool === 'text') vector.text = ui.vectorText;
      if (vector.tool === 'arrow') vector.tip = 'triangle';
      draft.current = { start, end: start, vector, constrain: e.shiftKey, polygonSides: ui.polygonSides };
      setSketch(draft.current);
      return;
    }

    if (!ui.termEdit && !ui.multiSelection.length && e.target instanceof HTMLElement && e.target.dataset.resizeCorner && ui.selection) {
      const object = project.objects.find((o) => o.id === ui.selection && o.plane);
      const b = rt.getBox(ui.selection);
      if (!object || !b) return;
      const corner = e.target.dataset.resizeCorner;
      const sx = corner.endsWith('e') ? 1 : -1;
      const sy = corner.startsWith('s') ? 1 : -1;
      // La esquina opuesta queda fija mientras se arrastra.
      dragRef.current = { kind: 'resize', id: object.id, sx, sy, anchor: { x: sx > 0 ? b.x : b.x + b.w, y: sy > 0 ? b.y : b.y + b.h } };
      return;
    }

    if (!ui.termEdit && e.target instanceof HTMLElement && e.target.dataset.vertexIndex !== undefined && ui.selection) {
      const target = rt.getVertexTarget(ui.selection, ui.pointerTool !== 'direct');
      const index = Number(e.target.dataset.vertexIndex);
      if (!target || !target.points[index]) return;
      const inverse = target.matrix.inverse();
      if (!Number.isFinite(inverse.a)) return;
      setActiveAnchor(index);
      dragRef.current = {
        kind: 'vertex', id: target.id, native: target.native, points: target.points, index,
        start: transformVertex(inverse, e.clientX, e.clientY), inverse, matrix: target.matrix, linear: target.linear,
      };
      return;
    }

    // Modo Edición de Términos: los clics eligen glifos de la ecuación (Mayús suma o quita).
    if (ui.termEdit) {
      const index = rt.glyphAt(ui.termEdit, e.clientX, e.clientY);
      if (index !== null) {
        const current = ui.glyphSel;
        actions.selectGlyphs(e.shiftKey ? (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]) : [index]);
        return;
      }
      if (rt.resolveTarget(e.target, true) === ui.termEdit) {
        if (!e.shiftKey) actions.selectGlyphs([]);
        return;
      }
      actions.exitTermEdit();
    }

    const selectTool = ui.pointerTool === 'select';
    const id = rt.resolveTarget(e.target, e.shiftKey);
    if (!id) {
      // Herramienta Selección: arrastrar desde un hueco dibuja la marquesina (Mayús conserva la selección actual).
      if (selectTool) {
        const base = e.shiftKey ? selectedObjectIds(store.getState().ui) : [];
        if (!e.shiftKey) actions.select(null);
        const start = position(e);
        dragRef.current = { kind: 'marquee', start, base };
        setMarquee({ a: start, b: start });
        return;
      }
      actions.select(null);
      dragRef.current = null;
      return;
    }
    const root = id.split('.')[0];
    const startGroupDrag = (ids: string[], copyOnMove = false) => {
      const objects = store.getState().project.objects;
      const origins: Record<string, Vertex> = {};
      for (const object of objects) if (ids.includes(object.id)) origins[object.id] = { x: object.x, y: object.y };
      dragRef.current = { kind: 'group', ids, sx: e.clientX, sy: e.clientY, origins, copyOnMove };
    };
    // Alt + arrastrar (estilo Illustrator): al empezar a mover se duplican el objeto o el grupo en su sitio y se
    // arrastran las copias; duplicado y desplazamiento comparten la misma entrada de historial.
    if (selectTool && e.altKey && !e.shiftKey) {
      const current = selectedObjectIds(ui);
      const ids = current.length > 1 && current.includes(root) ? current : [root];
      if (ids.length === 1 && current[0] !== root) actions.select(root);
      startGroupDrag(ids, true);
      lastClick.current = null;
      return;
    }
    // Mayús+clic con Selección: suma o quita el objeto del grupo; si queda dentro, se puede arrastrar el conjunto.
    if (selectTool && e.shiftKey) {
      actions.toggleSelection(root);
      const ids = selectedObjectIds(store.getState().ui);
      dragRef.current = null;
      if (ids.includes(root)) startGroupDrag(ids);
      lastClick.current = null;
      return;
    }
    // Clic sobre un miembro de la selección múltiple: se arrastra todo el grupo.
    const group = selectedObjectIds(ui);
    if (selectTool && group.length > 1 && group.includes(root)) {
      startGroupDrag(group);
      lastClick.current = null;
      return;
    }
    actions.select(id);
    // Doble clic (o herramienta Selección Directa) sobre una ecuación: edición de términos.
    const formula = project.objects.find((o) => o.id === id && o.kind === 'formula' && !o.vector);
    const previous = lastClick.current;
    lastClick.current = formula ? { id, t: e.timeStamp } : null;
    if (formula && (ui.pointerTool === 'direct' || (previous && previous.id === id && e.timeStamp - previous.t < DOUBLE_CLICK_MS))) {
      lastClick.current = null;
      actions.enterTermEdit(id);
      const index = rt.glyphAt(id, e.clientX, e.clientY);
      if (index !== null) actions.selectGlyphs([index]);
      dragRef.current = null;
      return;
    }
    if (ui.pointerTool === 'direct') return;
    const info = rt.getNodeInfo(id);
    if (!info) return;
    const obj = project.objects.find((o) => o.id === info.objId);
    if (info.isRoot) {
      if (obj) dragRef.current = { kind: 'root', id, sx: e.clientX, sy: e.clientY, ox: obj.x, oy: obj.y };
    } else {
      const node = (e.target as Element).closest(`[data-mm-id="${id}"]`) ?? null;
      const parent = node?.parentNode as SVGGraphicsElement | null;
      const m = parent && 'getScreenCTM' in parent ? parent.getScreenCTM() : null;
      if (m) {
        const st = project.styles[id];
        dragRef.current = { kind: 'child', id, sx: e.clientX, sy: e.clientY, ox: st?.tx ?? 0, oy: st?.ty ?? 0, inv: m.inverse() };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const active = pointer.current;
    if (!active || active.id !== e.pointerId || active.generation !== store.projectGeneration()) return;
    if (draft.current) {
      draft.current = { ...draft.current, end: position(e), constrain: e.shiftKey };
      setSketch(draft.current);
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'marquee') {
      const b = position(e);
      setMarquee({ a: d.start, b });
      const rt = engine.runtime;
      if (rt) actions.selectMany([...d.base, ...objectsInMarquee(rt, visibleObjectIds(rt), d.start, b).filter((id) => !d.base.includes(id))]);
      return;
    }
    if (d.kind === 'vertex') {
      moveVertex(d, e, active.group);
      return;
    }
    if (d.kind === 'resize') {
      resizePlane(d, e, active.group);
      return;
    }
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === 'group') {
      if (d.copyOnMove) {
        if (Math.hypot(dx, dy) < 3) return;
        // Las copias nacen exactamente en la posición original (desplazamiento 0) y son las que se arrastran.
        const copies = actions.duplicateObjects(d.ids, 0, active.group);
        if (!copies.length) return;
        const origins: Record<string, Vertex> = {};
        copies.forEach((id, i) => { origins[id] = d.origins[d.ids[i]]; });
        dragRef.current = { ...d, ids: copies, origins, copyOnMove: false };
        return onPointerMove(e);
      }
      const r = stageRef.current!.getBoundingClientRect();
      actions.translateObjects(d.ids, dx / (r.width / W), dy / (r.height / H), active.group, d.origins);
      return;
    }
    if (d.kind === 'root') {
      // El desplazamiento se divide entre la escala real del escenario en pantalla.
      const r = stageRef.current!.getBoundingClientRect();
      const kx = r.width / W;
      const ky = r.height / H;
      actions.updateObject(d.id, { x: d.ox + dx / kx, y: d.oy + dy / ky }, active.group);
    } else {
      const lx = d.inv.a * dx + d.inv.c * dy;
      const ly = d.inv.b * dx + d.inv.d * dy;
      actions.setStyle(d.id, { tx: d.ox + lx, ty: d.oy + ly }, active.group);
    }
  };

  /** Redimensiona un plano desde una esquina (ancho/alto del plano, no su escala), con la esquina opuesta fija. */
  function resizePlane(drag: Extract<Drag, { kind: 'resize' }>, event: PointerEvent, group: symbol) {
    const object = store.getState().project.objects.find((entry) => entry.id === drag.id);
    if (!object?.plane) return;
    const point = position(event);
    const stageW = Math.max(60, (point.x - drag.anchor.x) * drag.sx);
    const stageH = Math.max(60, (point.y - drag.anchor.y) * drag.sy);
    actions.editPlane(object, { width: Math.round(stageW / object.scale), height: Math.round(stageH / object.scale) }, group, {
      x: drag.anchor.x + (drag.sx * stageW) / 2, y: drag.anchor.y + (drag.sy * stageH) / 2,
    });
  }

  function moveVertex(drag: Extract<Drag, { kind: 'vertex' }>, event: PointerEvent, group: symbol) {
    const point = transformVertex(drag.inverse, event.clientX, event.clientY);
    const from = drag.points[drag.index];
    let edited = { x: from.x + (point.x - drag.start.x), y: from.y + (point.y - drag.start.y) };
    if (drag.linear && event.shiftKey && (point.x !== drag.start.x || point.y !== drag.start.y)) {
      const other = drag.points[1 - drag.index];
      const fixed = transformVertex(drag.matrix, other.x, other.y);
      const moved = transformVertex(drag.matrix, edited.x, edited.y);
      const dx = moved.x - fixed.x;
      const dy = moved.y - fixed.y;
      const step = Math.PI / 4;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      const length = Math.hypot(dx, dy);
      edited = transformVertex(drag.inverse, fixed.x + length * Math.cos(angle), fixed.y + length * Math.sin(angle));
    }
    if (!Number.isFinite(edited.x) || !Number.isFinite(edited.y)) return;
    const current = store.getState().project;
    const object = current.objects.find((entry) => entry.id === drag.id);
    const existing = drag.native && object
      ? drag.linear ? object.vector?.endpoints : object.vector?.vertices
      : current.styles[drag.id]?.vertices;
    // Un clic sobre el ancla por sí solo no cambia la geometría.
    const previous = existing?.[drag.index] ?? from;
    if (edited.x === previous.x && edited.y === previous.y) return;
    const points = drag.points.map((vertex, index) => index === drag.index ? edited : vertex);
    if (drag.native && object) {
      if (drag.linear) actions.editVector(object, { endpoints: [points[0], points[1]] }, group);
      else actions.editVector(object, { tool: 'polygon', vertices: points }, group);
    } else if (!drag.native) actions.setStyle(drag.id, { vertices: points }, group);
  }

  const endDrag = (event: React.PointerEvent) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    if (event.type === 'pointerup' && dragRef.current?.kind === 'vertex' && active.generation === store.projectGeneration()) {
      moveVertex(dragRef.current, event, active.group);
    }
    if (event.type === 'pointerup' && draft.current && active.generation === store.projectGeneration()) {
      const end = position(event);
      const start = draft.current.start;
      const rect = stageRef.current!.getBoundingClientRect();
      const pixelDistance = Math.hypot((end.x - start.x) * rect.width / W, (end.y - start.y) * rect.height / H);
      const polygonClick = draft.current.vector.tool === 'polygon' && pixelDistance < 3;
      const shape = sketchBounds({ ...draft.current, end, constrain: event.shiftKey });
      if (polygonClick) store.setUi({ polygonRequest: start });
      else if (shape) {
        const { x, y, bw, bh, vector } = shape;
        actions.addVector(vector, bw, bh, { x: x + bw / 2, y: y + bh / 2 });
      }
    }
    const drag = dragRef.current;
    if (event.type === 'pointerup' && drag?.kind === 'marquee' && active.generation === store.projectGeneration() && engine.runtime) {
      const end = position(event);
      const rect = stageRef.current!.getBoundingClientRect();
      const pixels = Math.hypot((end.x - drag.start.x) * rect.width / W, (end.y - drag.start.y) * rect.height / H);
      // Un clic sin arrastre en un hueco solo deselecciona (o conserva la selección con Mayús).
      const hits = pixels < 3 ? [] : objectsInMarquee(engine.runtime, visibleObjectIds(engine.runtime), drag.start, end);
      actions.selectMany([...drag.base, ...hits.filter((id) => !drag.base.includes(id))]);
    }
    pointer.current = null;
    dragRef.current = null;
    draft.current = null;
    setSketch(null);
    setMarquee(null);
  };

  const preview = sketch && sketchBounds(sketch);

  const sceneBg = resolveSceneBackground({ background, sceneBackground });
  const bg = sceneBg.bgColor;
  const legacyGrid = !sceneBackground && background === 'grid';
  const selected = selection;
  const anchorSize = 8 / (k * viewportScale);

  return (
    <div ref={wrapRef} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-ink-950">
      <PolygonOptions />
      <div style={{ width: W * k, height: H * k }} className="relative shadow-2xl shadow-black/60 ring-1 ring-bezel">
        <div
          ref={stageRef}
          data-stage
          tabIndex={-1}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          style={{
            width: W,
            height: H,
            transform: `scale(${k})`,
            transformOrigin: '0 0',
            position: 'absolute',
            left: 0,
            top: 0,
            overflow: 'hidden',
            background: bg,
            cursor: vectorTool ? 'crosshair' : 'default',
            touchAction: 'none',
            userSelect: 'none',
            outline: 'none',
          }}
        >
          <div className={`absolute inset-0 ${legacyGrid ? 'mm-grid' : ''}`} />
          {sceneBackground && <SceneBackdrop bg={sceneBg} width={W} height={H} />}
          <div ref={layerRef} className="absolute inset-0" />
          <svg ref={fxRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="absolute inset-0" style={{ pointerEvents: 'none' }} />

          {!hideUi && preview && (
            <div data-vector-preview className="pointer-events-none absolute opacity-70"
              style={{ left: preview.x, top: preview.y, width: preview.bw, height: preview.bh }}
              dangerouslySetInnerHTML={{ __html: vectorSvg(preview.vector, preview.bw, preview.bh) }} />
          )}

          {/* Elementos de interfaz del editor: no existen durante la reproducción ni la grabación */}
          {!hideUi && (
            <div className="mm-ui pointer-events-none absolute inset-0">
              {showGuides && (
                <>
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/15" />
                  <div className="absolute left-0 right-0 top-1/2 h-px bg-white/15" />
                  <div
                    className="absolute border border-dashed border-white/15"
                    style={{ left: W * 0.05, top: H * 0.05, width: W * 0.9, height: H * 0.9 }}
                  />
                </>
              )}
              {!multiSelection.length && selected && box && (
                <div
                  className="absolute"
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.w,
                    height: box.h,
                    outline: `${Math.max(2, 2 / k)}px dashed #5c9ef4`,
                    outlineOffset: `${3 / k}px`,
                  }}
                />
              )}
              {multiSelection.length > 0 && multiBoxes.map((b, i) => b && (
                <div key={`m${multiSelection[i]}`} data-multi-selected={multiSelection[i]} className="absolute"
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h,
                    outline: `${Math.max(2, 2 / k)}px dashed #5c9ef4`, outlineOffset: `${3 / k}px` }} />
              ))}
              {marquee && (
                <div data-marquee className="absolute"
                  style={{
                    left: Math.min(marquee.a.x, marquee.b.x), top: Math.min(marquee.a.y, marquee.b.y),
                    width: Math.abs(marquee.b.x - marquee.a.x), height: Math.abs(marquee.b.y - marquee.a.y),
                    border: `${Math.max(1, 1 / k)}px dashed ${MARQUEE_COLOR}`, background: 'rgba(88,196,221,0.12)',
                  }} />
              )}
              {!multiSelection.length && selectedPlane && box && selectedPlane.rotation === 0 && !selectedPlane.id.includes('.') && (
                (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                  const size = 9 / (k * viewportScale);
                  const cx = box.x + (corner.endsWith('e') ? box.w : 0);
                  const cy = box.y + (corner.startsWith('s') ? box.h : 0);
                  return (
                    <span key={corner} data-resize-corner={corner} title="Redimensionar plano"
                      className="pointer-events-auto absolute border border-accent bg-white"
                      style={{ left: cx - size / 2, top: cy - size / 2, width: size, height: size, borderWidth: size / 8,
                        cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }} />
                  );
                })
              )}
              {termEdit && glyphBoxes.map((b, i) => {
                if (!b) return null;
                const chosen = glyphSel.includes(i);
                const u = 1 / k;
                return (
                  <div key={`g${i}`} data-glyph-outline={i} data-selected={chosen || undefined} className="absolute"
                    style={{
                      left: b.x - 2 * u, top: b.y - 2 * u, width: b.w + 4 * u, height: b.h + 4 * u, borderRadius: 2 * u,
                      border: `${u}px solid ${chosen ? '#5c9ef4' : 'rgba(255,255,255,0.14)'}`,
                      background: chosen ? 'rgba(92,158,244,0.14)' : undefined,
                    }} />
                );
              })}
              {anchorsEnabled && anchors.map((vertex, index) => (
                <span key={index} data-vertex-index={index} title={`Vértice ${index + 1}`}
                  className={`pointer-events-auto absolute cursor-move border border-accent ${activeAnchor === index ? 'bg-accent' : 'bg-white'}`}
                  style={{ left: vertex.x - anchorSize / 2, top: vertex.y - anchorSize / 2,
                    width: anchorSize, height: anchorSize, borderWidth: anchorSize / 8 }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
