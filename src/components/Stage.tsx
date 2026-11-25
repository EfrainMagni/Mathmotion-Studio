import { regularPolygon, vectorSvg } from '../engine/vector';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { BACKGROUND_COLOR, STAGE_SIZES, type Box, type Obj2D, type VectorGeometry, type Vertex } from '../types';
import { actions, store, useStore } from '../store';
import { audio, engine } from '../engine';
import { SceneRuntime } from '../engine/runtime';
import { Playback } from '../engine/playback';
import { PolygonOptions } from './PolygonOptions';

type Drag =
  | { kind: 'root'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'child'; id: string; sx: number; sy: number; ox: number; oy: number; inv: DOMMatrix }
  | { kind: 'vertex'; id: string; native: Obj2D | null; index: number; points: Vertex[]; start: Vertex; inverse: DOMMatrix; matrix: DOMMatrix; linear: boolean };

type Sketch = { start: Vertex; end: Vertex; vector: VectorGeometry; constrain: boolean; polygonSides: number };

const NO_BOXES: (Box | null)[] = [];
const DOUBLE_CLICK_MS = 400;

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

/** Escenario del editor: capas de fondo, SVG, efectos y marcas de interfaz. */
export function Stage({ viewportScale }: { viewportScale: number }) {
  const format = useStore((s) => s.project.format);
  const background = useStore((s) => s.project.background);
  const playing = useStore((s) => s.ui.playing);
  const recPhase = useStore((s) => s.ui.recording.phase);
  const vectorTool = useStore((s) => s.ui.vectorTool);
  const direct = useStore((s) => s.ui.pointerTool === 'direct');
  const anchorsEnabled = useStore((s) => !!s.ui.selection && !s.ui.vectorTool && !s.ui.termEdit &&
    !s.ui.playing && s.ui.recording.phase === 'idle' && s.ui.pointerTool !== 'hand');
  const anchorProject = useStore((s) => anchorsEnabled ? s.project : null);
  const treeVersion = useStore((s) => anchorsEnabled ? s.ui.treeVersion : 0);
  const time = useStore((s) => anchorsEnabled ? s.ui.time : 0);
  const showGuides = useStore((s) => s.ui.showGuides);
  const selection = useStore((s) => s.ui.selection);
  const termEdit = useStore((s) => s.ui.termEdit);
  const glyphSel = useStore((s) => s.ui.glyphSel);

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

    const id = rt.resolveTarget(e.target, e.shiftKey);
    if (!id) {
      actions.select(null);
      dragRef.current = null;
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
    if (d.kind === 'vertex') {
      moveVertex(d, e, active.group);
      return;
    }
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
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
    pointer.current = null;
    dragRef.current = null;
    draft.current = null;
    setSketch(null);
  };

  const preview = sketch && sketchBounds(sketch);

  const bg = BACKGROUND_COLOR[background];
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
          <div className={`absolute inset-0 ${background === 'grid' ? 'mm-grid' : ''}`} />
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
              {selected && box && (
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
