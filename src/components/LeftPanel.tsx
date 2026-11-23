import { useEffect, useRef, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  FileUp,
  Layers,
  Loader2,
  Mic,
  Music,
  Play,
  Sigma,
  Square,
  Trash2,
  Triangle,
  Volume2,
} from 'lucide-react';
import { actions, store, useStore } from '../store';
import { SHAPE3D_LABEL, SOUND_IDS, SOUND_LABEL, STAGE_SIZES, type Shape3D, type SoundId } from '../types';
import { audio, engine } from '../engine';
import { SAMPLE_SVG, prepareSvg } from '../engine/svgImport';
import { formulaToPrepared, loadMathJax, texToSvg } from '../engine/mathjax';
import { Scene3D } from '../engine/three3d';
import type { TreeNode } from '../engine/runtime';
import { Field, NumberInput, Section, btn, btnPrimary, input } from './ui';

// ------------------------------------------------------------------ árbol de objetos

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  selection,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  selection: string | null;
}) {
  const open = expanded.has(node.id);
  const has = node.children.length > 0;
  const sel = selection === node.id;
  return (
    <>
      <div
        role="treeitem"
        aria-selected={sel}
        data-node-id={node.id}
        className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs ${sel ? 'bg-cyan-500/25 text-cyan-100' : 'hover:bg-white/5'}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => actions.select(node.id)}
      >
        {has ? (
          <button
            className="grid h-4 w-4 shrink-0 place-items-center text-slate-400"
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
            aria-label={open ? 'Contraer' : 'Expandir'}
            tabIndex={-1}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <span className="w-12 shrink-0 truncate font-mono text-[10px] text-slate-500">{node.tag}</span>
        <span className="truncate">{node.name}</span>
      </div>
      {open && has && node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} selection={selection} />
      ))}
    </>
  );
}

function ObjectsSection() {
  const objects = useStore((s) => s.project.objects);
  const selection = useStore((s) => s.ui.selection);
  useStore((s) => s.ui.treeVersion);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);

  // El lienzo y el árbol permanecen sincronizados: al seleccionar en el lienzo se despliegan los ancestros.
  useEffect(() => {
    if (!selection) return;
    const anc = engine.runtime?.getAncestors(selection) ?? [];
    if (anc.length) {
      setExpanded((prev) => {
        if (anc.every((a) => prev.has(a))) return prev;
        const n = new Set(prev);
        anc.forEach((a) => n.add(a));
        return n;
      });
    }
    requestAnimationFrame(() => {
      boxRef.current?.querySelector(`[data-node-id="${CSS.escape(selection)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  }, [selection]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Section title="Objetos" icon={<Layers size={14} />}>
      {objects.length === 0 && <p className="text-xs text-slate-500">Importa un SVG, inserta una fórmula o un objeto 3D.</p>}
      <div ref={boxRef} role="tree" className="scroll-thin max-h-72 overflow-auto rounded border border-white/5 bg-ink-900 p-1">
        {objects.map((o) => {
          const tree = o.kind === 'svg' ? engine.runtime?.getTree(o.id) : null;
          if (tree) {
            return (
              <div key={o.id} className="group relative">
                <TreeRow node={tree} depth={0} expanded={expanded} toggle={toggle} selection={selection} />
                <button
                  className="absolute right-1 top-0.5 hidden rounded p-0.5 text-slate-400 hover:text-rose-300 group-hover:block"
                  title="Eliminar objeto"
                  aria-label={`Eliminar ${o.name}`}
                  onClick={() => actions.removeObject(o.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          }
          const sel = selection === o.id;
          return (
            <div
              key={o.id}
              role="treeitem"
              aria-selected={sel}
              data-node-id={o.id}
              className={`group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs ${sel ? 'bg-cyan-500/25 text-cyan-100' : 'hover:bg-white/5'}`}
              style={{ paddingLeft: 20 }}
              onClick={() => actions.select(o.id)}
            >
              <span className="w-12 shrink-0 truncate font-mono text-[10px] text-slate-500">{o.kind === 'formula' ? 'tex' : o.kind === 'shape3d' ? '3d' : 'svg'}</span>
              <span className="truncate">{o.name}</span>
              <button
                className="ml-auto hidden rounded p-0.5 text-slate-400 hover:text-rose-300 group-hover:block"
                title="Eliminar objeto"
                aria-label={`Eliminar ${o.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.removeObject(o.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Clic en el lienzo = elemento hijo · Mayús+clic o Mayús+arrastrar = objeto completo.
      </p>
    </Section>
  );
}

// ------------------------------------------------------------------ SVG

function SvgSection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const addSvg = (text: string, name: string) => {
    const id = actions.reserveObjectId();
    const prepared = prepareSvg(text, id);
    const { w, h } = STAGE_SIZES[store.getState().project.format];
    const [, , bw, bh] = prepared.viewBox;
    actions.addObject2D({ id, kind: 'svg', name, markup: prepared.markup, sourceSvg: text, bw, bh, fit: Math.min(w / bw, h / bh) });
    setWarn(prepared.warnings);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setWarn([]);
    try {
      const generation = store.projectGeneration();
      const text = await file.text();
      if (generation !== store.projectGeneration()) return;
      addSvg(text, file.name.replace(/\.svg$/i, ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Section title="Importar SVG (Illustrator)" icon={<FileUp size={14} />}>
      <input ref={fileRef} type="file" accept=".svg,image/svg+xml" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} Importar SVG…
        </button>
        <button
          className={btn}
          disabled={busy}
          title="Inserta un SVG de prueba con grupos anidados, transformaciones, estilos y referencias internas"
          onClick={() => {
            setError(null);
            try {
              addSvg(SAMPLE_SVG, 'Triángulo de ejemplo');
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          <Triangle size={13} /> Ejemplo
        </button>
      </div>
      {error && <p role="alert" className="rounded bg-rose-500/15 p-2 text-xs text-rose-200">{error}</p>}
      {warn.map((w, i) => (
        <p key={i} className="rounded bg-amber-500/10 p-2 text-[11px] text-amber-200">{w}</p>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------ LaTeX

const DEFAULT_TEX = '\\int_{a}^{b} f(x)\\,dx';

function LatexSection() {
  const background = useStore((s) => s.project.background);
  const [tex, setTex] = useState(DEFAULT_TEX);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'fatal'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [inserting, setInserting] = useState(false);
  const [retry, setRetry] = useState(0);
  const color = background === 'light' ? '#0f172a' : '#f8fafc';

  useEffect(() => {
    if (!tex.trim()) {
      setStatus('error');
      setMessage('Escribe una fórmula.');
      setPreview('');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    const timer = window.setTimeout(async () => {
      try {
        await loadMathJax();
      } catch (e) {
        if (!cancelled) {
          setStatus('fatal');
          setMessage(e instanceof Error ? e.message : 'No se pudo cargar MathJax.');
        }
        return;
      }
      try {
        const { svgText } = await texToSvg(tex, '#f8fafc');
        const prepared = prepareSvg(svgText, 'preview');
        if (cancelled) return;
        setPreview(prepared.markup);
        setStatus('ok');
        setMessage(null);
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tex, retry]);

  const insert = async () => {
    setInserting(true);
    try {
      const id = actions.reserveObjectId();
      const generation = store.projectGeneration();
      const prepared = await formulaToPrepared(tex, id, color);
      if (generation !== store.projectGeneration()) return;
      const { w, h } = STAGE_SIZES[store.getState().project.format];
      const [, , bw, bh] = prepared.viewBox;
      const n = store.getState().project.objects.filter((o) => o.kind === 'formula').length + 1;
      actions.addObject2D({
        id,
        kind: 'formula',
        name: `Fórmula ${n}`,
        markup: prepared.markup,
        sourceSvg: prepared.sourceSvg,
        bw,
        bh,
        tex,
        fit: Math.min((w * 0.7) / bw, (h * 0.35) / bh),
      });
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setInserting(false);
    }
  };

  return (
    <Section title="Editor LaTeX" icon={<Sigma size={14} />}>
      <textarea
        className={`${input} h-16 resize-y font-mono`}
        value={tex}
        spellCheck={false}
        onChange={(e) => setTex(e.target.value)}
        aria-label="Fórmula LaTeX"
        aria-invalid={status === 'error'}
      />
      {status === 'error' && message && (
        <p role="alert" className="rounded bg-rose-500/15 p-2 font-mono text-[11px] text-rose-200">{message}</p>
      )}
      {status === 'fatal' && (
        <div className="space-y-1 rounded bg-rose-500/15 p-2 text-xs text-rose-200">
          <p>{message}</p>
          <button className={btn} onClick={() => setRetry((r) => r + 1)}>Reintentar</button>
        </div>
      )}
      <div className="relative flex min-h-[72px] items-center justify-center overflow-hidden rounded border border-white/10 bg-ink-900 p-2">
        {status === 'loading' && (
          <span className="absolute right-2 top-2 flex items-center gap-1 text-[11px] text-slate-400">
            <Loader2 size={12} className="animate-spin" /> Procesando…
          </span>
        )}
        {preview && (
          <div
            className={`max-h-24 max-w-full ${status === 'error' ? 'opacity-30' : ''}`}
            style={{ width: 180 }}
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        )}
      </div>
      <button className={btnPrimary} disabled={status !== 'ok' || inserting} onClick={() => void insert()}>
        {inserting ? <Loader2 size={13} className="animate-spin" /> : <Sigma size={13} />} Insertar fórmula
      </button>
    </Section>
  );
}

// ------------------------------------------------------------------ 3D

const SHAPES: { id: Shape3D; icon: React.ReactNode }[] = [
  { id: 'axes', icon: <Layers size={13} /> },
  { id: 'paraboloid', icon: <Circle size={13} /> },
  { id: 'sphere', icon: <Circle size={13} /> },
  { id: 'vector', icon: <Triangle size={13} /> },
];

function Shapes3DSection() {
  const webgl = useStore((s) => s.ui.webgl);
  const msg = useStore((s) => s.ui.webglMessage);
  const busy = useStore((s) => s.ui.recording.phase !== 'idle');
  const add = (shape: Shape3D) => {
    if (!Scene3D.supported()) {
      actions.notify('error', 'WebGL no está disponible en este navegador o dispositivo. El editor 2D sigue funcionando; los objetos 3D no se pueden insertar.');
      return;
    }
    actions.add3D(shape);
  };
  return (
    <Section title="Objetos 3D" icon={<Box size={14} />}>
      <div className="grid grid-cols-2 gap-2">
        {SHAPES.map((s) => (
          <button key={s.id} className={btn} disabled={busy} onClick={() => add(s.id)}>
            {s.icon} {SHAPE3D_LABEL[s.id]}
          </button>
        ))}
      </div>
      {webgl === 'loading' && (
        <p className="flex items-center gap-1 text-[11px] text-slate-400">
          <Loader2 size={12} className="animate-spin" /> Cargando Three.js…
        </p>
      )}
      {webgl === 'unavailable' && (
        <p role="alert" className="rounded bg-amber-500/10 p-2 text-[11px] text-amber-200">
          {msg ?? 'WebGL no disponible.'} Los objetos 3D no se dibujarán; el editor 2D sigue operativo.
        </p>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Audio

function AudioSection() {
  const voice = useStore((s) => s.project.voice);
  const selectedClip = useStore((s) => s.ui.selectedClip);
  const clipSound = useStore((s) => s.project.clips.find((c) => c.id === s.ui.selectedClip)?.sound ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!micOn) return;
    const t = window.setInterval(() => setElapsed(audio.micElapsed()), 200);
    return () => window.clearInterval(t);
  }, [micOn]);

  useEffect(() => () => audio.cancelMic(), []);

  const onFile = async (file?: File) => {
    if (!file) return;
    setErr(null);
    setLoading(true);
    try {
      const generation = store.projectGeneration();
      const buffer = await audio.decodeVoice(file);
      if (generation !== store.projectGeneration()) return;
      audio.voiceBuffer = buffer;
      actions.setVoice({ source: file, name: file.name, duration: buffer.duration, start: 0, volume: 1 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const toggleMic = async () => {
    setErr(null);
    if (!micOn) {
      try {
        const generation = store.projectGeneration();
        await audio.startMic(); // solicita permiso explícito al navegador
        if (generation !== store.projectGeneration()) {
          audio.cancelMic();
          return;
        }
        setMicOn(true);
        setElapsed(0);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } else {
      setMicOn(false);
      setLoading(true);
      try {
        const generation = store.projectGeneration();
        const { source, name, buffer } = await audio.stopMic();
        if (generation !== store.projectGeneration()) return;
        audio.voiceBuffer = buffer;
        actions.setVoice({ source, name, duration: buffer.duration, start: 0, volume: 1 });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <Section title="Audio y voz" icon={<Music size={14} />}>
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Efectos</p>
        {SOUND_IDS.map((id: SoundId) => (
          <div key={id} className="flex items-center gap-1.5 text-xs">
            <button className={btn} onClick={() => audio.playEffect(id)} aria-label={`Escuchar ${SOUND_LABEL[id]}`} title="Escuchar">
              <Play size={12} />
            </button>
            <span className={`flex-1 truncate ${clipSound === id ? 'text-cyan-300' : ''}`}>{SOUND_LABEL[id]}</span>
            <button
              className={btn}
              disabled={!selectedClip}
              title={selectedClip ? 'Asociar al clip seleccionado' : 'Selecciona un clip en la línea de tiempo'}
              onClick={() => selectedClip && actions.updateClip(selectedClip, { sound: clipSound === id ? null : id })}
            >
              {clipSound === id ? 'Quitar' : 'Asociar'}
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-2 border-t border-white/5 pt-2">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Pista de voz</p>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <div className="flex gap-2">
          <button className={btn} disabled={loading || micOn} onClick={() => fileRef.current?.click()}>
            {loading ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} Subir audio
          </button>
          <button className={micOn ? btnPrimary : btn} disabled={loading} onClick={() => void toggleMic()}>
            {micOn ? <Square size={13} /> : <Mic size={13} />} {micOn ? `Detener · ${elapsed.toFixed(1)} s` : 'Grabar voz'}
          </button>
        </div>
        {err && <p role="alert" className="rounded bg-rose-500/15 p-2 text-xs text-rose-200">{err}</p>}
        {voice && (
          <div className="space-y-1.5 rounded border border-white/10 bg-ink-900 p-2">
            <div className="flex items-center gap-1.5 text-xs">
              <Volume2 size={13} className="shrink-0 text-emerald-300" />
              <span className="truncate" title={voice.name}>{voice.name}</span>
              <button
                className="ml-auto text-slate-400 hover:text-rose-300"
                aria-label="Quitar pista de voz"
                title="Quitar pista de voz"
                onClick={() => {
                  audio.clearVoice();
                  actions.setVoice(null);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <Field label="Duración">
              <span className="font-mono text-xs">{voice.duration.toFixed(2)} s</span>
            </Field>
            <Field label="Inicio (s)">
              <NumberInput className={`${input} w-20`} value={voice.start} min={0} step={0.1} onChange={(v) => actions.updateVoice({ start: v })} />
            </Field>
            <Field label={`Volumen ${Math.round(voice.volume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={voice.volume}
                onChange={(e) => actions.updateVoice({ volume: parseFloat(e.target.value) })}
                className="w-28 accent-cyan-400"
              />
            </Field>
          </div>
        )}
      </div>
    </Section>
  );
}

export function LeftPanel() {
  return (
    <aside className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-r border-white/10 bg-ink-800">
      <ObjectsSection />
      <SvgSection />
      <LatexSection />
      <Shapes3DSection />
      <AudioSection />
    </aside>
  );
}
