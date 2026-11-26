import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import {
  Focus, Hand, Maximize, Minus, MousePointer, MousePointer2, PanelBottom,
  PanelLeft, PanelRight, Plus, X,
} from 'lucide-react';
import { engine } from './engine';
import { actions, selectedObjectIds, store, useStore } from './store';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { Stage } from './components/Stage';
import { Timeline } from './components/Timeline';

function Notice() {
  const notice = useStore((s) => s.ui.notice);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => store.setUi({ notice: null }), notice.kind === 'error' ? 12000 : 6000);
    return () => window.clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`absolute left-1/2 top-14 z-50 flex max-w-[640px] -translate-x-1/2 items-start gap-3 rounded-md border px-3 py-2 text-xs shadow-lg ${
        notice.kind === 'error' ? 'border-rose-400/40 bg-rose-950/95 text-rose-100' : 'border-bezel bg-ink-700/95 text-slate-100'
      }`}
    >
      <span className="leading-snug">{notice.text}</span>
      <button onClick={() => store.setUi({ notice: null })} aria-label="Cerrar aviso" className="shrink-0 opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

type Camera = { x: number; y: number; scale: number };
type Drag = { id: number; clientX: number; clientY: number };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function clampZoom(scale: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

function zoomAt(camera: Camera, scale: number, x: number, y: number): Camera {
  const ratio = scale / camera.scale;
  return {
    x: x - (x - camera.x) * ratio,
    y: y - (y - camera.y) * ratio,
    scale,
  };
}

function clearMouseFocus(event: MouseEvent<HTMLDivElement>) {
  if (event.detail > 0 && event.target instanceof Element) {
    event.target.closest('button')?.blur();
  }
}

const controlClass =
  'grid h-6 min-w-6 place-items-center rounded px-1 text-slate-300 ' +
  'hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-accent ' +
  'aria-pressed:bg-accent-soft aria-pressed:text-accent-light';

export function App() {
  const projectGeneration = useStore(() => store.projectGeneration());
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focus, setFocus] = useState(false);
  const [panels, setPanels] = useState({ left: true, right: true, timeline: true });
  const vectorTool = useStore((s) => s.ui.vectorTool);
  const pointerTool = useStore((s) => s.ui.pointerTool);
  const canPan = pointerTool === 'hand' || spaceHeld;
  const format = useStore((s) => s.project.format);

  // Al cargar o cambiar de formato (16:9 / 9:16) la vista vuelve a 100 % centrada.
  useEffect(() => setCamera({ x: 0, y: 0, scale: 1 }), [format, projectGeneration]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    function onWheel(event: WheelEvent) {
      if (!viewport || event.deltaY === 0) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      setCamera((current) => zoomAt(current, clampZoom(current.scale * factor), x, y));
    }

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Space' || event.defaultPrevented || event.isComposing ||
          event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest('input, textarea, select, button, [role="textbox"], [role="button"]')
      )) return;

      event.preventDefault();
      if (!event.repeat) setSpaceHeld(true);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') setSpaceHeld(false);
    }

    function onBlur() {
      setSpaceHeld(false);
      const viewport = viewportRef.current;
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (drag && viewport?.hasPointerCapture(drag.id)) {
        viewport.releasePointerCapture(drag.id);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    function onEditorKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || document.querySelector('dialog[open]')) return;
      // Ctrl/Cmd+D se atiende antes de la guarda de foco: tras tocar un deslizador, color, número o interruptor del
      // inspector el foco queda en ese control y antes el atajo se descartaba sin hacer nada. Solo se respeta la
      // escritura libre (áreas de texto, contenteditable y campos de texto).
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        const typing = event.target instanceof Element &&
          !!event.target.closest('textarea, [contenteditable]:not([contenteditable="false"]), input[type="text"], input[type="search"], input:not([type])');
        const { ui } = store.getState();
        if (!typing && !event.repeat && !ui.playing && ui.recording.phase === 'idle') actions.duplicateSelection();
        return;
      }
      // Ctrl/Cmd+Z y Ctrl/Cmd+Y (o Mayús+Z): igual que Ctrl+D, funcionan con el foco en deslizadores, selectores de
      // color, números o botones del inspector; solo se respetan los campos de escritura libre (deshacer nativo).
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        const typing = event.target instanceof Element &&
          !!event.target.closest('textarea, [contenteditable]:not([contenteditable="false"]), input[type="text"], input[type="search"], input:not([type])');
        if (typing || store.getState().ui.recording.phase !== 'idle') return;
        event.preventDefault();
        // Un control con el foco (deslizador, color…) podría reaplicar su valor viejo: se suelta antes de deshacer.
        if (event.target instanceof HTMLElement && event.target !== document.body && event.target.closest('input, select')) event.target.blur();
        engine.playback?.pause();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      const { ui, project } = store.getState();
      if (ui.recording.phase !== 'idle') return;
      const { selection, selectedClip } = ui;
      const root = selection?.split('.')[0];
      const object = project.objects.find((item) => item.id === root);
      const key = event.key.toLowerCase();

      if (event.ctrlKey || event.metaKey) return;
      if ((key === 'a' || key === 'v') && !ui.playing) {
        event.preventDefault();
        store.setUi({ pointerTool: key === 'a' ? 'direct' : 'select', vectorTool: null });
        return;
      }
      // G: inserta un plano cartesiano centrado en el escenario (no se dispara al editar texto: ver guarda inicial).
      if (key === 'g' && !event.shiftKey && !ui.playing) {
        event.preventDefault();
        if (!event.repeat) {
          store.setUi({ vectorTool: null, pointerTool: 'select' });
          actions.addCartesianPlane();
        }
        return;
      }
      if (event.key === 'Escape' && ui.termEdit) {
        event.preventDefault();
        actions.exitTermEdit();
        return;
      }
      if (event.key === 'Delete' || (event.key === 'Backspace' && selectedClip)) {
        if (ui.playing) return;
        const ids = selectedObjectIds(ui);
        if (selectedClip) actions.removeClip(selectedClip);
        else if (ids.length > 1 && !ui.termEdit) actions.removeObjects(ids);
        else if (object && !ui.termEdit) actions.removeObject(object.id);
        else return;
        event.preventDefault();
        return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = arrows[event.key as keyof typeof arrows];
      if (!direction) return;
      const step = event.shiftKey ? 10 : 1;
      const [dx, dy] = direction.map((value) => value * step);
      if (object && selection && !selectedClip && !ui.playing) {
        event.preventDefault();
        if (selection === object.id) {
          actions.updateObject(object.id, { x: object.x + dx, y: object.y + dy });
        } else {
          const delta = engine.runtime?.stageDeltaForNode(selection, dx, dy) ?? { x: dx, y: dy };
          const style = project.styles[selection];
          actions.setStyle(selection, { tx: (style?.tx ?? 0) + delta.x, ty: (style?.ty ?? 0) + delta.y });
        }
      } else if (dx && engine.playback) {
        event.preventDefault();
        engine.playback.step(dx);
      }
    }
    window.addEventListener('keydown', onEditorKey);
    return () => window.removeEventListener('keydown', onEditorKey);
  }, []);

  function startPan(event: PointerEvent<HTMLDivElement>) {
    const { pointerId, clientX, clientY, currentTarget } = event;
    if (!canPan || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    currentTarget.setPointerCapture(pointerId);
    dragRef.current = { id: pointerId, clientX, clientY };
    setDragging(true);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    setCamera((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function stepZoom(factor: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const x = viewport.clientWidth / 2;
    const y = viewport.clientHeight / 2;
    setCamera((current) => zoomAt(current, clampZoom(current.scale * factor), x, y));
  }

  function fitScene() {
    const viewport = viewportRef.current;
    const scene = sceneRef.current;
    if (!viewport || !scene || !scene.offsetWidth || !scene.offsetHeight) return;
    const { clientWidth: width, clientHeight: height } = viewport;
    const scale = clampZoom(Math.min(
      (width - 32) / scene.offsetWidth,
      (height - 88) / scene.offsetHeight,
    ));
    setCamera({
      x: (width - scene.offsetWidth * scale) / 2,
      y: Math.max(0, (height - 56 - scene.offsetHeight * scale) / 2),
      scale,
    });
  }

  return (
    <div className="relative flex h-full flex-col">
      <TopBar />
      <Notice />
      <div className="flex min-h-0 flex-1">
        <div id="studio-left" className={!focus && panels.left ? 'contents' : 'hidden'}>
          <LeftPanel key={projectGeneration} visible={!focus && panels.left} />
        </div>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            ref={viewportRef}
            className="absolute inset-0 overflow-hidden bg-slate-950"
            style={{
              cursor: dragging ? 'grabbing' : canPan ? 'grab' : undefined,
              touchAction: canPan || dragging ? 'none' : undefined,
            }}
            onPointerDownCapture={startPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onLostPointerCapture={endPan}
          >
            <div
              ref={sceneRef}
              className="absolute inset-0 origin-top-left"
              style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
            >
              <Stage viewportScale={camera.scale} />
            </div>
            {(canPan || dragging) && <div aria-hidden="true" className="absolute inset-0 z-10" />}
          </div>

          {!focus && (
            <div
              className="absolute right-1.5 top-1.5 z-20 flex rounded-lg border border-bezel bg-ink-700/95 p-0.5 backdrop-blur-md"
              onClick={clearMouseFocus}
            >
              {([
                { key: 'left', label: 'Panel izquierdo', Icon: PanelLeft },
                { key: 'right', label: 'Panel derecho', Icon: PanelRight },
                { key: 'timeline', label: 'Línea de tiempo', Icon: PanelBottom },
              ] as const).map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={controlClass}
                  aria-label={label}
                  title={label}
                  aria-controls={`studio-${key}`}
                  aria-pressed={panels[key]}
                  onClick={() => setPanels((current) => ({ ...current, [key]: !current[key] }))}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          )}

          <div
            role="group"
            aria-label="Controles del lienzo"
            onClick={clearMouseFocus}
            className="absolute bottom-2 left-1/2 z-20 flex max-w-[calc(100%_-_1rem)] -translate-x-1/2 flex-wrap justify-center gap-0.5 rounded-md border border-bezel bg-ink-700/95 p-1 shadow-xl backdrop-blur-md"
          >
            {(focus || !panels.left) && (
              <>
                <button type="button" className={controlClass} title="Seleccionar · V" aria-label="Seleccionar" aria-keyshortcuts="V"
                  aria-pressed={pointerTool === 'select' && !vectorTool}
                  onClick={() => store.setUi({ vectorTool: null, pointerTool: 'select' })}>
                  <MousePointer2 size={16} />
                </button>
                <button type="button" className={controlClass} title="Selección Directa (Vértices) · A"
                  aria-label="Selección Directa (Vértices)" aria-keyshortcuts="A" aria-pressed={pointerTool === 'direct'}
                  onClick={() => store.setUi({ pointerTool: 'direct', vectorTool: null })}>
                  <MousePointer size={15} />
                </button>
              </>
            )}
            <button type="button" className={controlClass} title="Mover (Espacio + arrastrar)"
              aria-label="Mover" aria-pressed={pointerTool === 'hand'} onClick={() => store.setUi({ vectorTool: null, pointerTool: 'hand' })}>
              <Hand size={16} />
            </button>
            <button type="button" className={controlClass} title="Alejar" aria-label="Alejar"
              onClick={() => stepZoom(1 / 1.2)}>
              <Minus size={16} />
            </button>
            <button type="button" className={`${controlClass} min-w-12 text-xs tabular-nums`}
              title="Restablecer vista al 100%"
              aria-label={`Zoom ${Math.round(camera.scale * 100)}%. Restablecer vista al 100%`}
              onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}>
              {Math.round(camera.scale * 100)}%
            </button>
            <button type="button" className={controlClass} title="Acercar" aria-label="Acercar"
              onClick={() => stepZoom(1.2)}>
              <Plus size={16} />
            </button>
            <button type="button" className={controlClass} title="Ajustar" aria-label="Ajustar"
              onClick={fitScene}>
              <Maximize size={16} />
            </button>
            <button type="button" className={controlClass} title="Modo Enfoque" aria-label="Modo Enfoque"
              aria-pressed={focus} onClick={() => setFocus((current) => !current)}>
              <Focus size={16} />
            </button>
          </div>
        </main>

        <div id="studio-right" className={!focus && panels.right ? 'contents' : 'hidden'}>
          <RightPanel />
        </div>
      </div>
      <div id="studio-timeline" className={!focus && panels.timeline ? 'contents' : 'hidden'}>
        <Timeline />
      </div>
    </div>
  );
}