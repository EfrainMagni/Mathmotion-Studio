import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus, RotateCcw, StepBack, StepForward, Trash2, Volume2 } from 'lucide-react';
import { actions, store, useStore } from '../store';
import { DISAPPEAR_MODES, FPS, SOUND_IDS, SOUND_LABEL, clipLabel, disappearModeOf, glyphTransformOf, groupTransformOf, parseGlyphIds, planeSubElementOf, planeSubLabel, sceneDuration, type Clip, type ClipParams, type Project, type SoundId } from '../types';
import { formatGlyphList } from '../engine/glyphs';
import { engine } from '../engine';
import { NumberInput, btn, input } from './ui';

/**
 * Parámetros de «Cambiar Color»: relleno (con opacidad opcional) y trazo, activables por separado.
 * Lo usan el editor de clips de la línea de tiempo y el panel Animaciones del inspector.
 */
export type ParamPatch = Record<string, ClipParams[string] | undefined>;

export function ColorChangeFields({ value, onChange, compact }: {
  value: ClipParams; onChange: (patch: ParamPatch) => void; compact?: boolean;
}) {
  const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : fallback);
  const fillOn = value.fillEnabled !== false && typeof value.targetFillColor === 'string';
  const strokeOn = value.strokeEnabled !== false && typeof value.targetStrokeColor === 'string';
  const opacityOn = typeof value.targetFillOpacity === 'number';
  const swatch = 'h-6 w-8 shrink-0 cursor-pointer rounded border border-bezel bg-transparent disabled:opacity-30';
  const row = compact ? 'flex items-center justify-between gap-1.5 text-[11px] text-slate-300' : 'flex items-center gap-1';
  return (
    <>
      <label className={row} title="Nuevo color de relleno (targetFillColor)">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={fillOn}
            onChange={(e) => onChange({ fillEnabled: e.target.checked, targetFillColor: hex(value.targetFillColor, '#ffff00') })} />
          Relleno
        </span>
        <input type="color" className={swatch} aria-label="Nuevo color de relleno" disabled={!fillOn}
          value={hex(value.targetFillColor, '#ffff00')} onChange={(e) => onChange({ targetFillColor: e.target.value, fillEnabled: true })} />
      </label>
      <label className={row} title="Opacidad de relleno al terminar (targetFillOpacity)">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={opacityOn} disabled={!fillOn}
            onChange={(e) => onChange({ targetFillOpacity: e.target.checked ? 1 : undefined })} />
          Opacidad
        </span>
        <NumberInput className={`${input} w-14`} value={opacityOn ? Math.round(Number(value.targetFillOpacity) * 100) : 100} min={0} max={100} step={5}
          disabled={!fillOn || !opacityOn} ariaLabel="Opacidad de relleno objetivo (%)"
          onChange={(v) => onChange({ targetFillOpacity: Math.min(1, Math.max(0, v / 100)) })} />
      </label>
      <label className={row} title="Nuevo color de trazo / contorno, también para líneas, flechas y puntas (targetStrokeColor)">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={strokeOn}
            onChange={(e) => onChange({ strokeEnabled: e.target.checked, targetStrokeColor: hex(value.targetStrokeColor, '#ffff00') })} />
          Trazo
        </span>
        <input type="color" className={swatch} aria-label="Nuevo color de trazo" disabled={!strokeOn}
          value={hex(value.targetStrokeColor, '#ffff00')} onChange={(e) => onChange({ targetStrokeColor: e.target.value, strokeEnabled: true })} />
      </label>
      {strokeOn && (
        <label className={row} title="Grosor del trazo al terminar, en px (targetStrokeWidth). En glifos crece hacia fuera">
          <span>Grosor (px)</span>
          <NumberInput className={`${input} w-14`} value={typeof value.targetStrokeWidth === 'number' ? value.targetStrokeWidth : 2} min={0.5} max={20} step={0.5}
            ariaLabel="Grosor de trazo objetivo (px)" onChange={(v) => onChange({ targetStrokeWidth: Math.min(20, Math.max(0.5, v)) })} />
        </label>
      )}
      <label className={row} title="Activo: 25 % entra al color nuevo, 50 % lo mantiene y 25 % regresa al color previo. Inactivo: el cambio es permanente">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={value.revertOnEnd === true}
            onChange={(e) => onChange({ revertOnEnd: e.target.checked ? true : undefined })} />
          Regresar al color original
        </span>
      </label>
    </>
  );
}

/** Aplica un parche de parámetros; `undefined` elimina la clave. */
export function patchParams(params: ClipParams, patch: ParamPatch): ClipParams {
  const next: ClipParams = { ...params };
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) delete next[key];
    else next[key] = v;
  }
  return next;
}

const LABEL_W = 116;
const LANE_H = 30;
const RULER_H = 20;
const SPEEDS = [0.5, 1, 1.5] as const;
const fmt = (n: number) => n.toFixed(2);

/** Alcance legible de un clip: término, glifos o destino (para bloques y descripciones). */
function clipSubject(clip: Clip, objects: Project['objects']): string {
  const p = clip.parameters;
  // Clip de una gráfica o punto de un plano cartesiano: «Plano · f(x) = x^2» / «Plano · Punto (2, 2)».
  const sub = planeSubElementOf(clip);
  if (sub) return `Plano · ${planeSubLabel(objects.find((o) => o.id === clip.targetId.split('.')[0])?.plane, sub)}`;
  const group = groupTransformOf(clip);
  if (group) {
    const names = (ids: string[]) => {
      const list = ids.map((id) => objects.find((o) => o.id === id)?.name ?? id);
      return list.length > 2 ? `${list.slice(0, 2).join(', ')}…` : list.join(', ');
    };
    return `· ${names(group.sourceObjectIds)} → ${names(group.targetObjectIds)}`;
  }
  const directed = glyphTransformOf(clip);
  if (directed) {
    const dest = objects.find((o) => o.id === directed.targetObjectId)?.name ?? directed.targetObjectId;
    const list = (id: string, ids: string[]) => formatGlyphList(parseGlyphIds(id, ids.join(',')));
    return `#${list(directed.sourceObjectId, directed.sourceGlyphIds)} → ${dest} #${list(directed.targetObjectId, directed.targetGlyphIds)}`;
  }
  const source = objects.find((o) => o.id === clip.targetId.split('.')[0]);
  const term = typeof p.term === 'string' && source ? source.terms?.find((t) => t.id === p.term) : undefined;
  const parts: string[] = [];
  if (term) parts.push(`«${term.name}»`);
  else if (typeof p.glyphs === 'string' && p.glyphs) parts.push(`#${p.glyphs}`);
  if (typeof p.to === 'string') parts.push(`→ ${objects.find((o) => o.id === p.to)?.name ?? p.to}`);
  return parts.join(' ');
}

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
  const objects = useStore((s) => s.project.objects);
  const runtimeName = (id: string) => engine.runtime?.nameOf(id) ?? id;
  if (!clip) {
    return <div className="text-xs text-slate-500">Selecciona un bloque para editar inicio, duración y sonido.</div>;
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="max-w-[200px] truncate font-medium text-slate-200" title={groupTransformOf(clip) ? clipSubject(clip, objects) : runtimeName(clip.targetId)}>
        {clipLabel(clip)} {groupTransformOf(clip) ? '' : `· ${planeSubElementOf(clip) ? '' : `${runtimeName(clip.targetId)} `}`}{clipSubject(clip, objects)}
      </span>
      {groupTransformOf(clip) && (
        <label className="flex items-center gap-1" title="Activo: el grupo origen permanece y una copia viaja (TransformFromCopy). Inactivo: el origen se reemplaza (ReplacementTransform)">
          <input type="checkbox" checked={clip.parameters.keepSource === true}
            onChange={(e) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, keepSource: e.target.checked } })} />
          Mantener grupo origen
        </label>
      )}
      {glyphTransformOf(clip) && (
        <label className="flex items-center gap-1" title="Los conectores (·, +, =) sin glifo dirigido brotan en el último 40 % del clip que completa a sus vecinos">
          <input type="checkbox" checked={clip.parameters.revealConnectors === true}
            onChange={(e) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, revealConnectors: e.target.checked } })} />
          Revelar conectores
        </label>
      )}
      {glyphTransformOf(clip) && (
        <label className="flex items-center gap-1" title="Activo: una copia del glifo viaja (TransformFromCopy). Inactivo: el glifo origen se mueve (ReplacementTransform)">
          <input type="checkbox" checked={clip.parameters.keepSource !== false}
            onChange={(e) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, keepSource: e.target.checked } })} />
          Mantener origen
        </label>
      )}
      {clip.type === 'draw' && (
        <label className="flex items-center gap-1" title="lag_ratio de Write (vacío = automático)">
          Lag
          <input type="number" min={0} step={0.05} placeholder="auto" aria-label="lag_ratio" className={`${input} w-14`}
            value={typeof clip.parameters.lagRatio === 'number' ? clip.parameters.lagRatio : ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              const { lagRatio: _previous, ...rest } = clip.parameters;
              actions.updateClip(clip.id, { parameters: Number.isFinite(v) ? { ...rest, lagRatio: Math.max(0, v) } : rest });
            }} />
        </label>
      )}
      {clip.type === 'indicate' && (
        <label className="flex items-center gap-1">
          Escala
          <NumberInput className={`${input} w-14`} value={typeof clip.parameters.scale === 'number' ? clip.parameters.scale : 1.3} min={0.1} step={0.1}
            onChange={(v) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, scale: v } })} ariaLabel="Escala del énfasis" />
        </label>
      )}
      {(clip.type === 'transform' || clip.type === 'transformMatch') && typeof clip.parameters.to === 'string' && !glyphTransformOf(clip) && (
        <label className="flex items-center gap-1" title="El origen queda fijo; una copia viaja al destino (origen.copy())">
          <input type="checkbox" checked={clip.parameters.keep === true}
            onChange={(e) => {
              const { keep: _previous, ...rest } = clip.parameters;
              actions.updateClip(clip.id, { parameters: e.target.checked ? { ...rest, keep: true } : rest });
            }} />
          Mantener ecuación origen
        </label>
      )}
      {clip.type === 'disappear' && (
        <select className={`${input} w-40`} aria-label="Modo de salida" title="Desvanecer = FadeOut · Contraer = ShrinkToCenter"
          value={disappearModeOf(clip.parameters)}
          onChange={(e) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, mode: e.target.value } })}>
          {DISAPPEAR_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
        </select>
      )}
      {clip.type === 'colorChange' && (
        <ColorChangeFields value={clip.parameters}
          onChange={(patch) => actions.updateClip(clip.id, { parameters: patchParams(clip.parameters, patch) })} />
      )}
      {(clip.type === 'indicate' || clip.type === 'circumscribe' || clip.type === 'focus') && (
        <input type="color" className="h-6 w-8 cursor-pointer rounded border border-bezel bg-transparent" aria-label="Color del énfasis"
          value={/^#[\da-f]{6}$/i.test(String(clip.parameters.color)) ? String(clip.parameters.color) : '#ffff00'}
          onChange={(e) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, color: e.target.value } })} />
      )}
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
  const objects = project.objects;
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

  // Espacio reproduce/pausa cuando el foco está fuera de campos y diálogos (igual en 16:9 y 9:16).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
      if (store.getState().ui.recording.phase !== 'idle') return;
      const pb = engine.playback;
      if (!pb) return;
      e.preventDefault();
      // Mantener Espacio (mano de desplazamiento) no debe alternar la reproducción en cada repetición.
      if (e.repeat) return;
      // Con el foco en un botón, el navegador también lo «pulsaría» al soltar Espacio (p. ej. Reproducir: doble
      // alternancia que se anula). Se suelta el foco para que Espacio solo reproduzca o pause.
      if (t?.closest('button,[role="button"]')) t.blur();
      pb.toggle();
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
            <Lane key={id} id={id} label={engine.runtime?.nameOf(id) ?? id} clips={clips.filter((c) => c.targetId === id)} objects={objects} pps={pps} width={width}
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
  objects,
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
  objects: Project['objects'];
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
            className={`absolute top-1 flex cursor-grab flex-col justify-center overflow-hidden rounded border px-1.5 text-[10px] leading-tight ${selectedClip === c.id ? 'border-accent bg-accent-soft' : c.type === 'groupTransform' ? 'border-dashed border-accent/60 bg-ink-600' : c.type === 'disappear' ? 'border-rose-400/60 bg-ink-600' : 'border-bezel bg-ink-600'}`}
            style={{ left: c.start * pps, width: Math.max(26, c.duration * pps), height: LANE_H - 8 }}
            onPointerDown={(e) => onDown(e, c.id, c.start)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            title={`${clipLabel(c)} ${clipSubject(c, objects)} · inicio ${fmt(c.start)} s · duración ${fmt(c.duration)} s${c.sound ? ` · ♪ ${SOUND_LABEL[c.sound]}` : ''}`}
          >
            <span className="truncate font-semibold">{clipLabel(c)} {clipSubject(c, objects)}</span>
            <span className="truncate font-mono text-[9px] opacity-90">
              {fmt(c.start)}s · {fmt(c.duration)}s{c.sound ? ` · ♪ ${SOUND_LABEL[c.sound]}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
