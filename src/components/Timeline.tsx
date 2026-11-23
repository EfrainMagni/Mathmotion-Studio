import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus, RotateCcw, StepBack, StepForward, Trash2, Volume2 } from 'lucide-react';
import { actions, store, useStore } from '../store';
import { CLIP_LABEL, FPS, SOUND_IDS, SOUND_LABEL, sceneDuration, type Clip, type SoundId } from '../types';
import { engine } from '../engine';
import { NumberInput, btn, input } from './ui';

const LABEL_W = 116;
const LANE_H = 30;
const RULER_H = 20;
const SPEEDS = [0.5, 1, 1.5] as const;
const fmt = (n: number) => n.toFixed(2);

function Transport() {
  const playing = useStore((s) => s.ui.playing);
  const speed = useStore((s) => s.ui.speed);
  const time = useStore((s) => s.ui.time);
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.ui.recording.phase !== 'idle');
  const total = sceneDuration(project);
  const pb = () => engine.playback;

  return (
    <div className="flex items-center gap-1.5">
      <button className={btn} disabled={busy} onClick={() => pb()?.restart()} title="Reiniciar (vuelve a 0 s y pausa)" aria-label="Reiniciar">
        <RotateCcw size={14} />
      </button>
      <button className={btn} disabled={busy} onClick={() => pb()?.step(-1)} title="Fotograma anterior (←)" aria-label="Fotograma anterior">
        <StepBack size={14} />
      </button>
      <button
        className="inline-flex h-6 w-8 items-center justify-center rounded-md bg-ink-600 text-slate-300 hover:bg-accent-soft disabled:opacity-40"
        disabled={busy}
        onClick={() => pb()?.toggle()}
        title={playing ? 'Pausa (Espacio)' : 'Reproducir (Espacio)'}
        aria-label={playing ? 'Pausa' : 'Reproducir'}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button className={btn} disabled={busy} onClick={() => pb()?.step(1)} title="Fotograma siguiente (→)" aria-label="Fotograma siguiente">
        <StepForward size={14} />
      </button>
      <div className="ml-1 flex overflow-hidden rounded-md border border-bezel" role="group" aria-label="Velocidad">
        {SPEEDS.map((s) => (
          <button
            key={s}
            disabled={busy}
            className={`min-h-6 px-2 text-xs ${speed === s ? 'bg-accent-soft text-accent-light' : 'bg-ink-700 hover:bg-ink-600'}`}
            onClick={() => {
              store.setUi({ speed: s });
              pb()?.setSpeed(s);
            }}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="ml-2 font-mono text-xs tabular-nums text-slate-300">
        {fmt(time)} s / {fmt(total)} s <span className="text-slate-500">· f{Math.round(time * FPS)}</span>
      </div>
    </div>
  );
}

function ClipEditor() {
  const clip = useStore((s) => s.project.clips.find((c) => c.id === s.ui.selectedClip) ?? null);
  const runtimeName = (id: string) => engine.runtime?.nameOf(id) ?? id;
  if (!clip) {
    return <div className="text-xs text-slate-500">Selecciona un bloque para editar inicio, duración y sonido.</div>;
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="max-w-[200px] truncate font-medium text-slate-200" title={runtimeName(clip.targetId)}>
        {CLIP_LABEL[clip.type]} · {runtimeName(clip.targetId)}
      </span>
      <label className="flex items-center gap-1">
        Inicio
        <NumberInput className={`${input} w-16`} value={clip.start} min={0} step={0.1} onChange={(v) => actions.updateClip(clip.id, { start: v })} ariaLabel="Inicio (s)" />
        s
      </label>
      <label className="flex items-center gap-1">
        Duración
        <NumberInput className={`${input} w-16`} value={clip.duration} min={0.05} step={0.1} onChange={(v) => actions.updateClip(clip.id, { duration: v })} ariaLabel="Duración (s)" />
        s
      </label>
      <select
        className={`${input} w-36`}
        value={clip.sound ?? ''}
        onChange={(e) => actions.updateClip(clip.id, { sound: (e.target.value || null) as SoundId | null })}
        aria-label="Sonido asociado"
      >
        <option value="">Sin sonido</option>
        {SOUND_IDS.map((id) => (
          <option key={id} value={id}>{SOUND_LABEL[id]}</option>
        ))}
      </select>
      <button className={btn} onClick={() => actions.removeClip(clip.id)} title="Eliminar clip (Supr)">
        <Trash2 size={13} /> Eliminar
      </button>
    </div>
  );
}

export function Timeline() {
  const clips = useStore((s) => s.project.clips);
  const voice = useStore((s) => s.project.voice);
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.ui.time);
  const selectedClip = useStore((s) => s.ui.selectedClip);
  const busy = useStore((s) => s.ui.recording.phase !== 'idle');
  useStore((s) => s.ui.treeVersion);
  const [pps, setPps] = useState(90);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string | 'voice'; sx: number; start: number; group: symbol } | null>(null);

  const total = sceneDuration(project);
  const span = Math.max(total + 3, 10);
  const width = span * pps;

  const lanes = useMemo(() => {
    const ids: string[] = [];
    for (const c of clips) if (!ids.includes(c.targetId)) ids.push(c.targetId);
    return ids;
  }, [clips]);

  // Espacio reproduce cuando el foco está fuera de campos y diálogos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
      if (store.getState().ui.recording.phase !== 'idle') return;
      const pb = engine.playback;
      if (!pb) return;
      if (e.code === 'Space') {
        e.preventDefault();
        pb.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cabezal: arrastrar sobre la regla en cualquier sentido.
  const seekFromEvent = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    engine.playback?.seek(Math.max(0, (e.clientX - rect.left) / pps));
  };
  const scrubbing = useRef(false);

  const startBlockDrag = (e: React.PointerEvent, id: string | 'voice', start: number) => {
    if (busy) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, sx: e.clientX, start, group: Symbol() };
    if (id !== 'voice') store.setUi({ selectedClip: id, selection: null });
  };
  const moveBlockDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const ns = Math.max(0, Math.round((d.start + (e.clientX - d.sx) / pps) * 100) / 100);
    if (d.id === 'voice') actions.updateVoice({ start: ns }, d.group);
    else actions.updateClip(d.id, { start: ns }, d.group);
  };
  const endBlockDrag = () => {
    dragRef.current = null;
  };

  const ticks: number[] = [];
  for (let s = 0; s <= span; s += 0.5) ticks.push(s);

  return (
    <div className="flex h-[184px] shrink-0 flex-col border-t border-bezel bg-ink-800">
      <div className="flex items-center justify-between gap-2 border-b border-bezel bg-ink-700 px-2 py-1">
        <Transport />
        <ClipEditor />
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => setPps((p) => Math.max(30, p / 1.25))} aria-label="Alejar"><Minus size={12} /></button>
          <button className={btn} onClick={() => setPps((p) => Math.min(300, p * 1.25))} aria-label="Acercar"><Plus size={12} /></button>
        </div>
      </div>

      <div ref={scrollRef} className="scroll-thin relative flex-1 overflow-auto">
        <div className="relative" style={{ width: LABEL_W + width, minHeight: '100%' }}>
          {/* Regla */}
          <div className="sticky top-0 z-20 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 shrink-0 border-b border-r border-bezel bg-ink-800" style={{ width: LABEL_W }} />
            <div
              className="relative cursor-col-resize border-b border-bezel bg-ink-900"
              style={{ width }}
              onPointerDown={(e) => {
                if (busy) return;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                scrubbing.current = true;
                seekFromEvent(e);
              }}
              onPointerMove={(e) => scrubbing.current && seekFromEvent(e)}
              onPointerUp={() => (scrubbing.current = false)}
              onPointerCancel={() => (scrubbing.current = false)}
            >
              {ticks.map((s) => (
                <div key={s} className="absolute top-0 border-l border-bezel" style={{ left: s * pps, height: s % 1 === 0 ? RULER_H : 8 }}>
                  {s % 1 === 0 && <span className="ml-1 text-[10px] text-slate-400">{s}s</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Pistas */}
          {lanes.map((id) => (
            <Lane key={id} id={id} label={engine.runtime?.nameOf(id) ?? id} clips={clips.filter((c) => c.targetId === id)} pps={pps} width={width}
              selectedClip={selectedClip} onDown={startBlockDrag} onMove={moveBlockDrag} onUp={endBlockDrag} />
          ))}
          <div className="flex" style={{ height: LANE_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-b border-r border-bezel bg-ink-800 px-2 text-xs text-slate-300" style={{ width: LABEL_W }}>
              <Volume2 size={12} /> Voz
            </div>
            <div className="relative border-b border-bezel" style={{ width }}>
              {voice ? (
                <div
                  className="absolute top-1 flex cursor-grab items-center gap-1 overflow-hidden rounded border border-bezel bg-ink-600 px-1.5 text-[11px]"
                  style={{ left: voice.start * pps, width: Math.max(24, voice.duration * pps), height: LANE_H - 8 }}
                  onPointerDown={(e) => startBlockDrag(e, 'voice', voice.start)}
                  onPointerMove={moveBlockDrag}
                  onPointerUp={endBlockDrag}
                  title={`${voice.name} · inicio ${fmt(voice.start)} s · duración ${fmt(voice.duration)} s`}
                >
                  <span className="truncate">{voice.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{fmt(voice.start)}s · {fmt(voice.duration)}s</span>
                </div>
              ) : (
                <span className="px-2 text-[11px] leading-[30px] text-slate-600">Sin pista de voz</span>
              )}
            </div>
          </div>
          {lanes.length === 0 && !voice && (
            <p className="px-3 py-3 text-xs text-slate-500" style={{ marginLeft: LABEL_W }}>
              Selecciona un objeto y usa los botones de Animaciones para crear clips en el cabezal.
            </p>
          )}

          {/* Cabezal */}
          <div className="pointer-events-none absolute top-0 z-40 w-px bg-accent" style={{ left: LABEL_W + time * pps, height: '100%' }}>
            <div className="absolute -left-[5px] top-0 h-3 w-[11px] rounded-b bg-accent" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Lane({
  id,
  label,
  clips,
  pps,
  width,
  selectedClip,
  onDown,
  onMove,
  onUp,
}: {
  id: string;
  label: string;
  clips: Clip[];
  pps: number;
  width: number;
  selectedClip: string | null;
  onDown: (e: React.PointerEvent, id: string, start: number) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
}) {
  return (
    <div className="flex" style={{ height: LANE_H }} data-lane={id}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-bezel bg-ink-800 px-2 text-xs text-slate-300" style={{ width: LABEL_W }} title={label}>
        <span className="truncate">{label}</span>
      </div>
      <div className="relative border-b border-bezel" style={{ width }}>
        {clips.map((c) => (
          <div
            key={c.id}
            data-clip={c.id}
            className={`absolute top-1 flex cursor-grab flex-col justify-center overflow-hidden rounded border px-1.5 text-[10px] leading-tight ${selectedClip === c.id ? 'border-accent bg-accent-soft' : 'border-bezel bg-ink-600'}`}
            style={{ left: c.start * pps, width: Math.max(26, c.duration * pps), height: LANE_H - 8 }}
            onPointerDown={(e) => onDown(e, c.id, c.start)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            title={`${CLIP_LABEL[c.type]} · inicio ${fmt(c.start)} s · duración ${fmt(c.duration)} s${c.sound ? ` · ♪ ${SOUND_LABEL[c.sound]}` : ''}`}
          >
            <span className="truncate font-semibold">{CLIP_LABEL[c.type]}</span>
            <span className="truncate font-mono text-[9px] opacity-90">
              {fmt(c.start)}s · {fmt(c.duration)}s{c.sound ? ` · ♪ ${SOUND_LABEL[c.sound]}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
