import { VECTOR_LABEL } from '../engine/vector';
import { useEffect, useRef, useState } from 'react';
import {
  Slash, MousePointer, MousePointer2, PenTool, Pentagon, Settings2, Shapes, Type, X,
  ChevronDown,
  ChevronRight,
  Circle,
  FileUp,
  Layers,
  Loader2,
  Mic,
  AudioLines,
  Play,
  Sigma,
  Square,
  Trash2,
  Triangle,
  Volume2,
} from 'lucide-react';
import { actions, selectedObjectIds, store, useStore } from '../store';
import { SOUND_IDS, SOUND_LABEL, STAGE_SIZES, type SoundId, type VectorTool } from '../types';
import { audio, engine } from '../engine';
import { SAMPLE_SVG, prepareSvg } from '../engine/svgImport';
import { formulaToPrepared, loadMathJax, texToSvg } from '../engine/mathjax';
import type { TreeNode } from '../engine/runtime';
import { Field, NumberInput, btn, btnPrimary, input } from './ui';

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
        className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs ${sel ? 'bg-accent-soft text-accent-light' : 'hover:bg-white/5'}`}
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
    <>
      <SavedGroupChips />
      {objects.length === 0 && <p className="text-xs text-slate-500">Importa un SVG o inserta una fórmula.</p>}
      <div ref={boxRef} role="tree" className="scroll-thin max-h-72 overflow-auto rounded border border-bezel bg-ink-900 p-1">
        {objects.map((o) => {
          const tree = o.kind === 'svg' && !o.plane ? engine.runtime?.getTree(o.id) : null;
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
              className={`group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs ${sel ? 'bg-accent-soft text-accent-light' : 'hover:bg-white/5'}`}
              style={{ paddingLeft: 20 }}
              onClick={() => actions.select(o.id)}
            >
              <span className="w-12 shrink-0 truncate font-mono text-[10px] text-slate-500">{o.kind === 'formula' ? 'tex' : o.plane ? 'plano' : 'svg'}</span>
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
    </>
  );
}

/**
 * Grupos guardados con etiqueta como chips: un clic selecciona todos sus objetos, aunque estén superpuestos con los
 * de otro grupo (p. ej. «Triángulo» y «Pentágono» en el mismo sitio). Se crean y editan desde el Inspector.
 */
function SavedGroupChips() {
  const groups = useStore((s) => s.project.savedGroups) ?? [];
  const objects = useStore((s) => s.project.objects);
  const selection = useStore((s) => s.ui.selection);
  const multi = useStore((s) => s.ui.multiSelection);
  if (!groups.length) return null;
  const selected = selectedObjectIds({ selection, multiSelection: multi });
  const exists = (id: string) => objects.some((object) => object.id === id);
  return (
    <div className="space-y-1" aria-label="Grupos guardados">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Grupos guardados</div>
      <div className="flex flex-wrap gap-1">
        {groups.map((group) => {
          const members = group.objectIds.filter(exists);
          const active = members.length > 0 && members.length === selected.length && members.every((id) => selected.includes(id));
          return (
            <button key={group.id} type="button"
              className={`max-w-full truncate rounded border px-1.5 py-0.5 text-[11px] ${active ? 'border-accent bg-accent-soft text-accent-light' : 'border-bezel bg-ink-700 text-slate-200 hover:bg-ink-600'}`}
              title={`Seleccionar ${members.length} objeto(s): ${members.map((id) => objects.find((object) => object.id === id)?.name ?? id).join(', ')}`}
              onClick={() => actions.selectSavedGroup(group.id)}>
              {group.name} ({members.length})
            </button>
          );
        })}
      </div>
    </div>
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
    <>
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
    </>
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
        // Más grande por defecto: ocupa hasta el 85 % del ancho y el 55 % del alto del lienzo.
        fit: Math.min((w * 0.85) / bw, (h * 0.55) / bh),
      });
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setInserting(false);
    }
  };

  return (
    <>
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
      <div className="relative flex min-h-[56px] items-center justify-center overflow-hidden rounded border border-bezel bg-ink-900 p-2">
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
    </>
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
        actions.setVoice({ source, name, duration: buffer.duration, start: 0, volume: 1 });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <div className="space-y-1">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Efectos</p>
        {SOUND_IDS.map((id: SoundId) => (
          <div key={id} className="flex items-center gap-1.5 text-xs">
            <button className={btn} onClick={() => audio.playEffect(id)} aria-label={`Escuchar ${SOUND_LABEL[id]}`} title="Escuchar">
              <Play size={12} />
            </button>
            <span className={`flex-1 truncate ${clipSound === id ? 'text-accent-light' : ''}`}>{SOUND_LABEL[id]}</span>
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

      <div className="space-y-1.5 border-t border-bezel pt-2">
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
          <div className="space-y-1.5 rounded border border-bezel bg-ink-900 p-2">
            <div className="flex items-center gap-1.5 text-xs">
              <Volume2 size={13} className="shrink-0 text-emerald-300" />
              <span className="truncate" title={voice.name}>{voice.name}</span>
              <button
                className="ml-auto text-slate-400 hover:text-rose-300"
                aria-label="Quitar pista de voz"
                title="Quitar pista de voz"
                onClick={() => actions.setVoice(null)}
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
                className="w-28 accent-accent"
              />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}

/** Plano cartesiano: ejes cruzados con puntas de flecha sobre una retícula sutil. */
function CartesianPlaneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <path d="M5.5 3.5v17M18.5 3.5v17M3.5 5.5h17M3.5 18.5h17" strokeWidth="1" opacity="0.35" />
      <path d="M2.5 12h16.2M12 21.5V5.3" strokeWidth="1.8" />
      <path d="M22 12l-3.6-2 1 2-1 2zM12 2l-2 3.6 2-1 2 1z" fill="currentColor" stroke="none" />
    </svg>
  );
}

const DRAW_TOOLS = [
  { id: 'select', label: 'Selección', shortcut: 'V', icon: MousePointer2 },
  { id: 'direct', label: 'Selección Directa (Vértices)', shortcut: 'A', icon: MousePointer },
  { id: 'rectangle', label: VECTOR_LABEL.rectangle, shortcut: 'R', icon: Square },
  { id: 'ellipse', label: VECTOR_LABEL.ellipse, shortcut: 'E', icon: Circle },
  { id: 'polygon', label: VECTOR_LABEL.polygon, shortcut: 'Y', icon: Pentagon },
  { id: 'line', label: VECTOR_LABEL.line, shortcut: '\\', icon: Slash },
  { id: 'pen', label: VECTOR_LABEL.pen, shortcut: 'P', icon: PenTool },
  { id: 'text', label: VECTOR_LABEL.text, shortcut: 'T', icon: Type },
] as const satisfies readonly { id: VectorTool | 'select' | 'direct'; label: string; shortcut: string; icon: typeof Square }[];

const MODULES = [
  { id: 'layers', label: 'Capas / Objetos', shortcut: '2', icon: Layers, content: ObjectsSection },
  { id: 'svg', label: 'Importar SVG', shortcut: '3', icon: FileUp, content: SvgSection },
  { id: 'latex', label: 'Editor LaTeX', shortcut: '4', icon: Sigma, content: LatexSection },
  { id: 'audio', label: 'Audio y voz', shortcut: '5', icon: AudioLines, content: AudioSection },
] as const;

type Module = typeof MODULES[number]['id'];
type Flyout = Module | 'text';

export function LeftPanel({ visible }: { visible: boolean }) {
  const active = useStore((s) => s.ui.vectorTool);
  const pointer = useStore((s) => s.ui.pointerTool);
  const text = useStore((s) => s.ui.vectorText);
  const disabled = useStore((s) => s.ui.playing || s.ui.recording.phase !== 'idle');
  const [drawing, setDrawing] = useState(true);
  const [open, setOpen] = useState<Flyout | null>(null);
  const rail = useRef<HTMLElement>(null);
  const textInput = useRef<HTMLInputElement>(null);

  function selectTool(tool: typeof DRAW_TOOLS[number]['id']) {
    if (tool === 'select' || tool === 'direct') {
      store.setUi({ vectorTool: null, pointerTool: tool });
    } else {
      store.setUi({ vectorTool: tool, pointerTool: 'select' });
    }
    setOpen((current) => tool === 'text' ? 'text' : current === 'text' ? null : current);
  }

  function insertPlane() {
    store.setUi({ vectorTool: null, pointerTool: 'select' });
    actions.addCartesianPlane();
  }

  function close(flyout: Flyout) {
    setOpen(null);
    rail.current?.querySelector<HTMLButtonElement>(`[aria-controls="left-flyout-${flyout}"]`)?.focus();
  }

  useEffect(() => {
    if (open === 'text' && visible) textInput.current?.focus();
  }, [open, visible]);

  useEffect(() => {
    if (active !== 'text') setOpen((current) => current === 'text' ? null : current);
  }, [active]);

  useEffect(() => {
    if (!visible) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey ||
        document.querySelector('dialog[open]')) return;
      const editing = event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.closest('input, textarea, select'));
      const inRail = event.target instanceof Node && rail.current?.contains(event.target);
      if (event.key === 'Escape' && open && (inRail || (!editing && !store.getState().ui.termEdit))) {
        event.preventDefault();
        close(open);
        return;
      }
      if (editing || event.repeat) return;
      if (event.altKey) {
        if (event.code === 'Digit1') {
          event.preventDefault();
          setDrawing((current) => !current);
        }
        const module = MODULES.find(({ shortcut }) => event.code === `Digit${shortcut}`);
        if (module) {
          event.preventDefault();
          setOpen((current) => current === module.id ? null : module.id);
        }
        return;
      }
      if (disabled) return;
      const tool = DRAW_TOOLS.find(({ shortcut }) => shortcut === event.key.toUpperCase());
      if (!tool || tool.id === 'select' || tool.id === 'direct') return;
      event.preventDefault();
      setDrawing(true);
      selectTool(tool.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, open, visible]);

  return (
    <aside ref={rail} className="studio-left" aria-label="Herramientas y módulos">
      <div className="studio-left-rail scroll-thin">
        <button type="button" className="studio-rail-button" aria-label="Herramientas vectoriales"
          title="Herramientas vectoriales · Alt+1" aria-keyshortcuts="Alt+1"
          aria-expanded={drawing} aria-controls="left-drawing-tools" onClick={() => setDrawing(!drawing)}>
          <Shapes size={20} aria-hidden="true" />
        </button>
        <div id="left-drawing-tools" className="studio-drawing" role="group" aria-label="Dibujo vectorial" hidden={!drawing}>
          {DRAW_TOOLS.map(({ id, label, shortcut, icon: Icon }) => (
            <button key={id} type="button" className="studio-rail-button" aria-label={label}
              title={id === 'line' || id === 'pen' ? `${label} (${shortcut})` : `${label} · ${shortcut}`} aria-keyshortcuts={shortcut} disabled={disabled}
              aria-pressed={id === 'select' || id === 'direct' ? !active && pointer === id : active === id}
              onClick={() => selectTool(id)}>
              <Icon size={20} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="studio-rail-button" aria-label="Plano cartesiano"
            title="Plano cartesiano (G)" aria-keyshortcuts="G" disabled={disabled} onClick={insertPlane}>
            <CartesianPlaneIcon />
          </button>
          {active === 'polygon' && (
            <button type="button" className="studio-rail-button" disabled={disabled}
              aria-label="Opciones de polígono" title="Opciones de polígono"
              onClick={() => store.setUi({ polygonRequest: 'options' })}>
              <Settings2 size={20} aria-hidden="true" />
            </button>
          )}
          {active === 'text' && (
            <button type="button" className="studio-rail-button" disabled={disabled}
              aria-label="Opciones de texto" title="Opciones de texto"
              aria-expanded={open === 'text'} aria-controls="left-flyout-text"
              onClick={() => setOpen(open === 'text' ? null : 'text')}>
              <Settings2 size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="studio-rail-modules">
          {MODULES.map(({ id, label, shortcut, icon: Icon }) => (
            <button key={id} type="button" className="studio-rail-button" aria-label={label}
              title={`${label} · Alt+${shortcut}`} aria-keyshortcuts={`Alt+${shortcut}`}
              aria-expanded={open === id} aria-controls={`left-flyout-${id}`}
              onClick={() => setOpen(open === id ? null : id)}>
              <Icon size={20} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      {MODULES.map(({ id, label, content: Content }) => (
        <section key={id} id={`left-flyout-${id}`} aria-label={label} className="studio-left-flyout scroll-thin" hidden={open !== id}>
          <div className="studio-flyout-heading">
            <h2>{label}</h2>
            <button type="button" className="studio-rail-button" aria-label={`Cerrar ${label}`} onClick={() => close(id)}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="space-y-1.5 p-2"><Content /></div>
        </section>
      ))}
      <section id="left-flyout-text" aria-label="Texto libre" className="studio-left-flyout scroll-thin" hidden={open !== 'text'}>
        <div className="studio-flyout-heading">
          <h2>Texto libre</h2>
          <button type="button" className="studio-rail-button" aria-label="Cerrar Texto libre" onClick={() => close('text')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-1.5 p-2">
          <Field label="Texto para dibujar">
            <input ref={textInput} className={input} value={text} maxLength={250}
              onChange={(event) => store.setUi({ vectorText: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                close('text');
              }} />
          </Field>
        </div>
      </section>
    </aside>
  );
}
