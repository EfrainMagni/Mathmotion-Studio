import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BACKGROUND_COLOR, STAGE_SIZES, is2D, type Box } from '../types';
import { actions, store, useStore } from '../store';
import { audio, engine } from '../engine';
import { SceneRuntime } from '../engine/runtime';
import { Playback } from '../engine/playback';

type Drag =
  | { kind: 'root'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'child'; id: string; sx: number; sy: number; ox: number; oy: number; inv: DOMMatrix }
  | { kind: 'camera'; sx: number; sy: number; az: number; el: number };

/** Escenario del editor: capas de fondo, 3D, SVG, efectos y marcas de interfaz. */
export function Stage() {
  const format = useStore((s) => s.project.format);
  const background = useStore((s) => s.project.background);
  const playing = useStore((s) => s.ui.playing);
  const recPhase = useStore((s) => s.ui.recording.phase);
  const cameraMode = useStore((s) => s.ui.cameraMode);
  const showGuides = useStore((s) => s.ui.showGuides);
  const selection = useStore((s) => s.ui.selection);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<SVGSVGElement>(null);
  const host3dRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [k, setK] = useState(0.4);
  const [box, setBox] = useState<Box | null>(null);

  const { w: W, h: H } = STAGE_SIZES[format];
  const hideUi = playing || recPhase === 'recording' || recPhase === 'preparing' || recPhase === 'finishing';

  // Runtime y línea de tiempo maestra: se crean una vez y se liberan al desmontar.
  useEffect(() => {
    const rt = new SceneRuntime(
      { stage: stageRef.current!, layer: layerRef.current!, fx: fxRef.current!, host3d: host3dRef.current! },
      {
        onWebgl: (status, message) => store.setUi({ webgl: status, webglMessage: message }),
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

  // Rueda: acercar/alejar la cámara solo en modo cámara.
  useEffect(() => {
    const el = stageRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!store.getState().ui.cameraMode) return;
      e.preventDefault();
      const cam = store.getState().project.camera;
      actions.setCamera({ dist: Math.min(30, Math.max(3, cam.dist * (e.deltaY > 0 ? 1.08 : 0.92))) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const { ui, project } = store.getState();
    if (e.button !== 0 || ui.playing || ui.recording.phase !== 'idle') return;
    const rt = engine.runtime;
    if (!rt) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (ui.cameraMode) {
      dragRef.current = { kind: 'camera', sx: e.clientX, sy: e.clientY, az: project.camera.az, el: project.camera.el };
      return;
    }
    const id = rt.resolveTarget(e.target, e.shiftKey);
    if (!id) {
      actions.select(null);
      dragRef.current = null;
      return;
    }
    actions.select(id);
    const info = rt.getNodeInfo(id);
    if (!info) return;
    const obj = project.objects.find((o) => o.id === info.objId);
    if (info.isRoot) {
      if (obj && is2D(obj)) dragRef.current = { kind: 'root', id, sx: e.clientX, sy: e.clientY, ox: obj.x, oy: obj.y };
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
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === 'camera') {
      actions.setCamera({
        az: d.az - dx * 0.4,
        el: Math.max(-85, Math.min(85, d.el + dy * 0.4)),
      });
    } else if (d.kind === 'root') {
      // El desplazamiento se divide entre la escala real del escenario en pantalla.
      const r = stageRef.current!.getBoundingClientRect();
      const kx = r.width / W;
      const ky = r.height / H;
      actions.updateObject(d.id, { x: d.ox + dx / kx, y: d.oy + dy / ky });
    } else {
      const lx = d.inv.a * dx + d.inv.c * dy;
      const ly = d.inv.b * dx + d.inv.d * dy;
      actions.setStyle(d.id, { tx: d.ox + lx, ty: d.oy + ly });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const bg = BACKGROUND_COLOR[background];
  const selected = selection;

  return (
    <div ref={wrapRef} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-ink-950">
      <div style={{ width: W * k, height: H * k }} className="relative shadow-2xl shadow-black/60 ring-1 ring-white/10">
        <div
          ref={stageRef}
          data-stage
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
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
            cursor: cameraMode ? 'grab' : 'default',
            touchAction: 'none',
          }}
        >
          <div className={`absolute inset-0 ${background === 'grid' ? 'mm-grid' : ''}`} />
          <div ref={host3dRef} className="absolute inset-0" style={{ pointerEvents: 'none' }} />
          <div ref={layerRef} className="absolute inset-0" />
          <svg ref={fxRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="absolute inset-0" style={{ pointerEvents: 'none' }} />

          {/* Elementos de interfaz del editor: no existen durante la reproducción ni la grabación */}
          {!hideUi && (
            <div className="mm-ui pointer-events-none absolute inset-0">
              {showGuides && (
                <>
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-cyan-300/25" />
                  <div className="absolute left-0 right-0 top-1/2 h-px bg-cyan-300/25" />
                  <div
                    className="absolute border border-dashed border-cyan-300/20"
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
                    outline: `${Math.max(2, 2 / k)}px dashed #22d3ee`,
                    outlineOffset: `${3 / k}px`,
                  }}
                />
              )}
              {cameraMode && (
                <div className="absolute left-4 top-4 rounded bg-black/60 px-3 py-1.5 text-[26px] text-cyan-200">
                  Modo cámara: arrastra para orbitar · rueda para acercar
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
