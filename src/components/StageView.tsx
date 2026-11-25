import { useEffect, useRef, useState } from 'react';
import { BACKGROUND_COLOR, STAGE_SIZES } from '../types';
import { SceneRuntime } from '../engine/runtime';
import { channelName, type EditorToStage, type StageToEditor } from '../engine/stageLink';
import { store, useStore } from '../store';

/**
 * Vista limpia del escenario (ventana de grabación): solo capas visuales, sin guías,
 * marcas de selección ni paneles. El editor le envía el proyecto y el tiempo.
 */
export function StageView({ sessionId }: { sessionId: string }) {
  const format = useStore((s) => s.project.format);
  const background = useStore((s) => s.project.background);
  const [ready, setReady] = useState(false);
  const [k, setK] = useState(0.4);
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<SVGSVGElement>(null);
  const { w: W, h: H } = STAGE_SIZES[format];

  useEffect(() => {
    document.title = 'MathMotion · vista de grabación';
    const rt = new SceneRuntime({
      stage: stageRef.current!,
      layer: layerRef.current!,
      fx: fxRef.current!,
    });
    const ch = new BroadcastChannel(channelName(sessionId));
    const onMsg = async (e: MessageEvent<EditorToStage>) => {
      const m = e.data;
      if (m.type === 'project') {
        store.replaceProject(m.project);
        rt.setProject(m.project);
        rt.renderAt(rt.time);
        setReady(true);
        ch.postMessage({ type: 'applied', token: m.token } satisfies StageToEditor);
      } else if (m.type === 'time') {
        rt.renderAt(m.t);
      }
    };
    ch.addEventListener('message', onMsg);
    ch.postMessage({ type: 'hello' } satisfies StageToEditor);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
      rt.dispose();
    };
  }, [sessionId]);

  // Ajusta el escenario a la ventana conservando la proporción lógica.
  useEffect(() => {
    const fit = () => setK(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [W, H]);

  const bg = BACKGROUND_COLOR[background];
  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden" style={{ background: bg }}>
      <div style={{ width: W * k, height: H * k, position: 'relative' }}>
        <div
          ref={stageRef}
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
          }}
        >
          <div className={`absolute inset-0 ${background === 'grid' ? 'mm-grid' : ''}`} />
          <div ref={layerRef} className="absolute inset-0" />
          <svg ref={fxRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="absolute inset-0" />
        </div>
      </div>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400" style={{ pointerEvents: 'none' }}>
          Esperando al editor…
        </div>
      )}
    </div>
  );
}
