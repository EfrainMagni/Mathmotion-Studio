import { useEffect, useMemo, useRef, useState } from 'react';
import { Magnet, Minus, Music2, Pause, Play, Plus, RotateCcw, StepBack, StepForward, Trash2, Volume2 } from 'lucide-react';
import { actions, store, useStore } from '../store';
import { DEFAULT_FOCUS, DEFAULT_INDICATE_STROKE_WIDTH, DISAPPEAR_MODES, FOCUS_LIMITS, FPS, SFX_VOLUME_MAX, SOUND_CATEGORIES, SOUND_IDS, SOUND_LABEL, SOUND_META, clipLabel, disappearModeOf, focusSpecOf, glyphTransformOf, groupTransformOf, indicateSpecOf, parseGlyphIds, planeSubElementOf, planeSubLabel, sceneDuration, soundDuration, type Clip, type ClipParams, type FocusParams, type Project, type SfxClip, type SoundId } from '../types';
import { formatGlyphList } from '../engine/glyphs';
import { audio, engine } from '../engine';

// El motor de audio necesita los efectos sueltos para la reproducción en vivo y para la mezcla offline del `.mp4`.
audio.setTimelineSfx(store.getState().project.sfx);
store.subscribe(() => audio.setTimelineSfx(store.getState().project.sfx));
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

const hexOr = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
const clampPx = (v: number) => Math.min(20, Math.max(0.5, v));
const SWATCH = 'h-6 w-8 shrink-0 cursor-pointer rounded border border-bezel bg-transparent disabled:opacity-30';

/**
 * Relleno y Contorno de «Indicate», activables por separado (`useFill`, `color`, `strokeColor`, `strokeWidth`).
 * Lo usan el editor de clips de la línea de tiempo y los paneles Animaciones del Objeto / de Glifos del inspector.
 * `onPickStart` abre un grupo de historial para que un arrastre del selector de color sea un solo `Ctrl+Z`.
 */
export function IndicateFields({ value, onChange, compact, onPickStart }: {
  value: ClipParams; onChange: (patch: ParamPatch) => void; compact?: boolean; onPickStart?: () => void;
}) {
  const spec = indicateSpecOf(value);
  const strokeOn = spec.strokeColor !== null;
  const row = compact ? 'flex items-center justify-between gap-1.5 text-[11px] text-slate-300' : 'flex items-center gap-1';
  return (
    <>
      <label className={row} title="Teñir el relleno durante el pulso (useFill). Inactivo: el relleno conserva su color original">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={spec.useFill} onChange={(e) => onChange({ useFill: e.target.checked ? undefined : false })} />
          Relleno
        </span>
        <input type="color" className={SWATCH} aria-label="Color de relleno de Indicate" disabled={!spec.useFill}
          value={hexOr(value.color, '#ffff00')} onPointerDown={onPickStart} onFocus={onPickStart}
          onChange={(e) => onChange({ color: e.target.value })} />
      </label>
      <label className={row} title="Contorno exterior luminoso que crece hacia fuera durante el pulso (strokeColor)">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={strokeOn}
            onChange={(e) => onChange(e.target.checked
              ? { strokeColor: hexOr(value.color, '#ffff00'), strokeWidth: DEFAULT_INDICATE_STROKE_WIDTH }
              : { strokeColor: undefined, strokeWidth: undefined })} />
          Contorno
        </span>
        <input type="color" className={SWATCH} aria-label="Color de contorno de Indicate" disabled={!strokeOn}
          value={hexOr(spec.strokeColor, '#ffff00')} onPointerDown={onPickStart} onFocus={onPickStart}
          onChange={(e) => onChange({ strokeColor: e.target.value })} />
      </label>
      {strokeOn && (
        <label className={row} title="Grosor del contorno en px (strokeWidth, 0.5–20). En glifos crece hacia fuera sin deformar la letra">
          <span>Grosor (px)</span>
          <NumberInput className={`${input} w-14`} value={spec.strokeWidth} min={0.5} max={20} step={0.5}
            ariaLabel="Grosor del contorno de Indicate (px)" onChange={(v) => onChange({ strokeWidth: clampPx(v) })} />
        </label>
      )}
    </>
  );
}

/**
 * Contorno de «Enfoque / Spotlight» (`useStrokeColor`, `highlightStrokeColor`, `highlightStrokeWidth`): los objetivos
 * brillan por su contorno exterior, por su relleno (`useHighlightColor`) o por ambos.
 */
export function FocusStrokeFields({ value, onChange, compact, onPickStart }: {
  value: Pick<FocusParams, 'useStrokeColor' | 'highlightStrokeColor' | 'highlightStrokeWidth'>;
  onChange: (patch: Partial<Pick<FocusParams, 'useStrokeColor' | 'highlightStrokeColor' | 'highlightStrokeWidth'>>) => void;
  compact?: boolean; onPickStart?: () => void;
}) {
  const on = value.useStrokeColor === true;
  const row = compact ? 'flex items-center justify-between gap-1.5 text-[11px] text-slate-300' : 'flex items-center gap-1';
  return (
    <>
      <label className={row} title="Contorno exterior luminoso de los objetivos (useStrokeColor), independiente del relleno">
        <span className="flex items-center gap-1">
          <input type="checkbox" checked={on} onChange={(e) => onChange({ useStrokeColor: e.target.checked })} />
          Contorno
        </span>
        <input type="color" className={SWATCH} aria-label="Color de contorno de enfoque" disabled={!on}
          value={hexOr(value.highlightStrokeColor, DEFAULT_FOCUS.highlightStrokeColor.toLowerCase())}
          onPointerDown={onPickStart} onFocus={onPickStart}
          onChange={(e) => onChange({ highlightStrokeColor: e.target.value })} />
      </label>
      {on && (
        <label className={row} title="Grosor del contorno en px (highlightStrokeWidth, 0.5–20)">
          <span>Grosor (px)</span>
          <NumberInput className={`${input} w-14`} value={value.highlightStrokeWidth ?? DEFAULT_FOCUS.highlightStrokeWidth} min={0.5} max={20} step={0.5}
            ariaLabel="Grosor del contorno de enfoque (px)" onChange={(v) => onChange({ highlightStrokeWidth: clampPx(v) })} />
        </label>
      )}
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
/** Pista propia de los clips Enfoque / Spotlight (afectan a varios objetos y a toda la escena). */
const FOCUS_LANE = '__focus__';
const laneOf = (clip: Clip) => (focusSpecOf(clip) ? FOCUS_LANE : clip.targetId);

/** Alcance legible de un clip: término, glifos o destino (para bloques y descripciones). */
function clipSubject(clip: Clip, objects: Project['objects']): string {
  const p = clip.parameters;
  // Clip de una gráfica o punto de un plano cartesiano: «Plano · f(x) = x^2» / «Plano · Punto (2, 2)».
  const sub = planeSubElementOf(clip);
  if (sub) return `Plano · ${planeSubLabel(objects.find((o) => o.id === clip.targetId.split('.')[0])?.plane, sub)}`;
  const focus = focusSpecOf(clip);
  if (focus) {
    const list = focus.targets.map((entry) => {
      const name = objects.find((o) => o.id === entry.objectId)?.name ?? entry.objectId;
      return entry.glyphIndices?.length ? `${name} #${formatGlyphList(entry.glyphIndices)}` : name;
    });
    return `· ${list.length > 2 ? `${list.slice(0, 2).join(', ')}…` : list.join(', ')}`;
  }
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
  // Un arrastre de deslizador o de selector de color = una sola entrada de historial (Ctrl+Z).
  const dragGroup = useRef<symbol>(Symbol('clip-param'));
  const startGroup = () => { dragGroup.current = Symbol('clip-param'); };
  if (!clip) {
    return <div className="text-xs text-slate-500">Selecciona un bloque para editar inicio, duración y sonido.</div>;
  }
  const focus = focusSpecOf(clip);
  const multi = !!groupTransformOf(clip) || !!focus;
  const setFocusParam = (patch: ClipParams) => actions.updateClip(clip.id, { parameters: { ...clip.parameters, ...patch } }, dragGroup.current);
  // Solo un arrastre de selector de color comparte entrada de historial; interruptores y grosores son pasos propios.
  const pickGroup = (patch: object) => {
    const keys = Object.keys(patch);
    return keys.length === 1 && /color$/i.test(keys[0]) ? dragGroup.current : undefined;
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="max-w-[200px] truncate font-medium text-slate-200" title={multi ? clipSubject(clip, objects) : runtimeName(clip.targetId)}>
        {clipLabel(clip)} {multi ? '' : `· ${planeSubElementOf(clip) ? '' : `${runtimeName(clip.targetId)} `}`}{clipSubject(clip, objects)}
      </span>
      {focus && (
        <>
          <label className="flex items-center gap-1" title="Opacidad a la que baja todo lo que no está enfocado (dimOpacity)">
            Resto
            <input type="range" className="w-16 accent-accent" aria-label="Oscurecer resto de escena (dimOpacity)"
              min={FOCUS_LIMITS.dimOpacity.min * 100} max={FOCUS_LIMITS.dimOpacity.max * 100} step={1} value={Math.round(focus.dimOpacity * 100)}
              onPointerDown={startGroup} onKeyDown={startGroup}
              onChange={(e) => setFocusParam({ dimOpacity: parseFloat(e.target.value) / 100 })} />
            <span className="w-8 tabular-nums text-slate-400">{Math.round(focus.dimOpacity * 100)}%</span>
          </label>
          <label className="flex items-center gap-1" title="Teñir los objetivos con el color de enfoque (si no, conservan su color y solo brillan)">
            <input type="checkbox" checked={focus.useHighlightColor} onChange={(e) => setFocusParam({ useHighlightColor: e.target.checked })} />
            Color
          </label>
          <input type="color" className="h-6 w-8 cursor-pointer rounded border border-bezel bg-transparent disabled:opacity-30" aria-label="Color de enfoque"
            disabled={!focus.useHighlightColor}
            value={/^#[\da-f]{6}$/i.test(focus.highlightColor) ? focus.highlightColor.toLowerCase() : '#ffff00'}
            onPointerDown={startGroup} onFocus={startGroup}
            onChange={(e) => setFocusParam({ highlightColor: e.target.value })} />
          <FocusStrokeFields value={focus} onPickStart={startGroup}
            onChange={(patch) => actions.updateClip(clip.id, {
              // Al activar el contorno se guardan explícitos color y grosor (los valores por defecto si no había).
              parameters: patchParams(clip.parameters, patch.useStrokeColor
                ? { highlightStrokeColor: focus.highlightStrokeColor, highlightStrokeWidth: focus.highlightStrokeWidth, ...patch }
                : patch),
            }, pickGroup(patch))} />
          <label className="flex items-center gap-1" title="Realce de escala de los objetivos (pulseScale, 1.0× – 1.5×)">
            Realce
            <NumberInput className={`${input} w-14`} value={focus.pulseScale} min={FOCUS_LIMITS.pulseScale.min} max={FOCUS_LIMITS.pulseScale.max} step={0.02}
              onChange={(v) => setFocusParam({ pulseScale: Math.min(FOCUS_LIMITS.pulseScale.max, Math.max(FOCUS_LIMITS.pulseScale.min, v)) })}
              ariaLabel="Realce de tamaño (pulseScale)" />
          </label>
        </>
      )}
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
      {clip.type === 'indicate' && (
        <IndicateFields value={clip.parameters} onPickStart={startGroup}
          onChange={(patch) => actions.updateClip(clip.id, { parameters: patchParams(clip.parameters, patch) }, pickGroup(patch))} />
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
      {(clip.type === 'circumscribe' || (clip.type === 'focus' && !focus)) && (
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

// ------------------------------------------------------------------ efectos de sonido sueltos

/** Píxeles de atracción del imán al arrastrar un efecto (Alt lo desactiva). */
const SNAP_PX = 8;
const SFX_ROW_H = 22;

const updateSfx = (id: string, patch: Partial<Omit<SfxClip, 'id'>>, group?: symbol) => {
  store.setProject((p) => {
    if (!p.sfx?.some((s) => s.id === id)) return p;
    return {
      ...p,
      sfx: p.sfx.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch };
        next.start = Math.max(0, Math.round(next.start * 100) / 100);
        next.duration = Math.round(soundDuration(next.sound, next.duration) * 100) / 100;
        next.volume = Math.min(SFX_VOLUME_MAX, Math.max(0, next.volume));
        return next;
      }),
    };
  }, group);
};

const removeSfx = (id: string) => {
  store.setProject((p) => {
    if (!p.sfx?.some((s) => s.id === id)) return p;
    const sfx = p.sfx.filter((s) => s.id !== id);
    return { ...p, sfx: sfx.length ? sfx : undefined };
  });
};

/** Reparte los efectos en filas para que no se tapen (greedy por orden de inicio). */
function packSfxRows(list: readonly SfxClip[], pps: number): { rows: Map<string, number>; count: number } {
  const rows = new Map<string, number>();
  const ends: number[] = [];
  for (const s of [...list].sort((a, b) => a.start - b.start)) {
    const w = Math.max(56 / pps, soundDuration(s.sound, s.duration));
    let row = ends.findIndex((e) => e <= s.start + 1e-6);
    if (row < 0) row = ends.length;
    ends[row] = s.start + w;
    rows.set(s.id, row);
  }
  return { rows, count: Math.max(1, ends.length) };
}

function SfxEditor({ sfx }: { sfx: SfxClip }) {
  const meta = SOUND_META[sfx.sound];
  // Un arrastre del deslizador de volumen = una sola entrada de historial (Ctrl+Z).
  const dragGroup = useRef<symbol>(Symbol('sfx-volume'));
  const startGroup = () => { dragGroup.current = Symbol('sfx-volume'); };
  return (
    <div className="flex items-center gap-2 text-xs">
      <Music2 size={13} className="shrink-0 text-sky-300" />
      <select className={`${input} w-44`} value={sfx.sound} aria-label="Efecto de sonido"
        onChange={(e) => {
          const sound = e.target.value as SoundId;
          updateSfx(sfx.id, { sound, duration: SOUND_META[sound].duration });
        }}>
        {SOUND_CATEGORIES.map((cat) => (
          <optgroup key={cat.id} label={cat.label}>
            {SOUND_IDS.filter((id) => SOUND_META[id].category === cat.id).map((id) => (
              <option key={id} value={id}>{SOUND_LABEL[id]}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <button className={btn} onClick={() => audio.playEffect(sfx.sound, undefined, sfx.duration, sfx.volume)} title="▶ Probar sonido" aria-label="Probar sonido">
        <Play size={12} />
      </button>
      <label className="flex items-center gap-1">
        Inicio
        <NumberInput className={`${input} w-16`} value={sfx.start} min={0} step={0.05} onChange={(v) => updateSfx(sfx.id, { start: v })} ariaLabel="Inicio del efecto (s)" />
        s
      </label>
      {meta.resizable && (
        <label className="flex items-center gap-1" title={`Duración ajustable (${meta.resizable.min}–${meta.resizable.max} s)`}>
          Duración
          <NumberInput className={`${input} w-16`} value={sfx.duration} min={meta.resizable.min} max={meta.resizable.max} step={0.05}
            onChange={(v) => updateSfx(sfx.id, { duration: v })} ariaLabel="Duración del efecto (s)" />
          s
        </label>
      )}
      <label className="flex items-center gap-1" title="Volumen individual de este efecto">
        Vol.
        <input type="range" className="w-16 accent-accent" min={0} max={SFX_VOLUME_MAX} step={0.05} value={sfx.volume} aria-label="Volumen del efecto"
          onPointerDown={startGroup} onKeyDown={startGroup} onChange={(e) => updateSfx(sfx.id, { volume: parseFloat(e.target.value) }, dragGroup.current)} />
        <span className="w-9 tabular-nums text-slate-400">{Math.round(sfx.volume * 100)}%</span>
      </label>
      <button className={btn} onClick={() => removeSfx(sfx.id)} title="Eliminar efecto (Supr)">
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
  const dragRef = useRef<{ id: string | 'voice'; sx: number; start: number; group: symbol; mode: 'move' | 'resize' } | null>(null);
  const sfxList = project.sfx ?? [];
  const [selectedSfx, setSelectedSfx] = useState<string | null>(null);
  const sfxSel = sfxList.find((s) => s.id === selectedSfx) ?? null;
  const sfxDragRef = useRef<{ id: string; sx: number; start: number; duration: number; group: symbol; mode: 'move' | 'resize'; targets: number[] } | null>(null);
  /** Instante al que se ha imantado el efecto que se arrastra (guía vertical). */
  const [snapAt, setSnapAt] = useState<number | null>(null);

  const total = sceneDuration(project);
  const span = Math.max(total + 3, 10);
  const width = span * pps;

  const sfxRows = useMemo(() => packSfxRows(sfxList, pps), [sfxList, pps]);
  const sfxLaneH = Math.max(LANE_H, sfxRows.count * SFX_ROW_H + 6);

  // Seleccionar un clip de animación (aquí o desde otro panel) suelta la selección del efecto.
  useEffect(() => {
    if (selectedClip) setSelectedSfx(null);
  }, [selectedClip]);

  // Supr / Retroceso borra el efecto seleccionado (fuera de campos de texto).
  useEffect(() => {
    if (!selectedSfx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      removeSfx(selectedSfx);
      setSelectedSfx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSfx]);

  const lanes = useMemo(() => {
    const ids: string[] = [];
    for (const c of clips) if (!ids.includes(laneOf(c))) ids.push(laneOf(c));
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

  /** Arrastre de un bloque: `move` desplaza el inicio; `resize` (asa derecha) cambia la duración. */
  const startBlockDrag = (e: React.PointerEvent, id: string | 'voice', start: number, mode: 'move' | 'resize' = 'move') => {
    if (busy) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, sx: e.clientX, start, group: Symbol(), mode };
    setSelectedSfx(null);
    if (id !== 'voice') store.setUi({ selectedClip: id, selection: null });
  };
  const moveBlockDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'resize' && d.id !== 'voice') {
      actions.updateClip(d.id, { duration: Math.max(0.1, Math.round((d.start + (e.clientX - d.sx) / pps) * 100) / 100) }, d.group);
      return;
    }
    const ns = Math.max(0, Math.round((d.start + (e.clientX - d.sx) / pps) * 100) / 100);
    if (d.id === 'voice') actions.updateVoice({ start: ns }, d.group);
    else actions.updateClip(d.id, { start: ns }, d.group);
  };
  const endBlockDrag = () => {
    dragRef.current = null;
  };

  /**
   * Arrastre de un efecto suelto. `move` desplaza su inicio con imán hacia el inicio (y el final) de cualquier
   * animación, la voz, el cabezal y los demás efectos; Alt lo desactiva. `resize` (asa derecha) estira los ajustables.
   */
  const startSfxDrag = (e: React.PointerEvent, sfx: SfxClip, mode: 'move' | 'resize' = 'move') => {
    if (busy) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const s = store.getState();
    const p = s.project;
    const targets = [
      ...p.clips.map((c) => c.start), // prioridad: inicio de cada animación
      ...p.clips.map((c) => c.start + c.duration),
      ...(p.voice ? [p.voice.start] : []),
      s.ui.time,
      ...(p.sfx ?? []).filter((o) => o.id !== sfx.id).map((o) => o.start),
    ];
    sfxDragRef.current = { id: sfx.id, sx: e.clientX, start: sfx.start, duration: sfx.duration, group: Symbol('sfx-drag'), mode, targets };
    setSelectedSfx(sfx.id);
    store.setUi({ selectedClip: null, selection: null });
  };
  const moveSfxDrag = (e: React.PointerEvent) => {
    const d = sfxDragRef.current;
    if (!d) return;
    const delta = (e.clientX - d.sx) / pps;
    if (d.mode === 'resize') {
      updateSfx(d.id, { duration: d.duration + delta }, d.group);
      return;
    }
    let next = Math.max(0, d.start + delta);
    let snapped: number | null = null;
    if (!e.altKey) {
      let best = SNAP_PX / pps;
      for (const target of d.targets) {
        const dist = Math.abs(target - next);
        if (dist < best - 1e-9) {
          best = dist;
          snapped = target;
        }
      }
      if (snapped !== null) next = snapped;
    }
    setSnapAt(snapped);
    updateSfx(d.id, { start: snapped !== null ? next : Math.round(next * 100) / 100 }, d.group);
  };
  const endSfxDrag = () => {
    sfxDragRef.current = null;
    setSnapAt(null);
  };

  const ticks: number[] = [];
  for (let s = 0; s <= span; s += 0.5) ticks.push(s);

  return (
    <div className="flex h-[184px] shrink-0 flex-col border-t border-bezel bg-ink-800">
      <div className="flex items-center justify-between gap-2 border-b border-bezel bg-ink-700 px-2 py-1">
        <Transport />
        {sfxSel ? <SfxEditor sfx={sfxSel} /> : <ClipEditor />}
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
            <Lane key={id} id={id} label={id === FOCUS_LANE ? '✦ Enfoque / Spotlight' : engine.runtime?.nameOf(id) ?? id} clips={clips.filter((c) => laneOf(c) === id)} objects={objects} pps={pps} width={width}
              selectedClip={selectedClip} onDown={startBlockDrag} onMove={moveBlockDrag} onUp={endBlockDrag} />
          ))}
          <div className="flex" style={{ height: sfxLaneH }} data-lane="__sfx__">
            <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-b border-r border-bezel bg-ink-800 px-2 text-xs text-slate-300" style={{ width: LABEL_W }}
              title="Efectos de sonido sueltos: arrástralos para cuadrarlos con el inicio de una animación (imán; Alt lo desactiva)">
              <Music2 size={12} /> Efectos <Magnet size={10} className="ml-auto text-slate-500" />
            </div>
            <div className="relative border-b border-bezel" style={{ width }}>
              {sfxList.length === 0 && (
                <span className="px-2 text-[11px] leading-[30px] text-slate-600">Sin efectos · usa «+ Añadir» en Audio y voz</span>
              )}
              {sfxList.map((sfx) => {
                const meta = SOUND_META[sfx.sound];
                const dur = soundDuration(sfx.sound, sfx.duration);
                const selected = selectedSfx === sfx.id;
                return (
                  <div
                    key={sfx.id}
                    data-sfx={sfx.id}
                    className={`absolute flex cursor-grab items-center gap-1 overflow-hidden rounded border px-1.5 text-[10px] leading-tight ${selected ? 'border-accent bg-accent-soft' : 'border-sky-400/50 bg-sky-900/40'}`}
                    style={{ left: sfx.start * pps, width: Math.max(56, dur * pps), top: 3 + (sfxRows.rows.get(sfx.id) ?? 0) * SFX_ROW_H, height: SFX_ROW_H - 4 }}
                    onPointerDown={(e) => startSfxDrag(e, sfx)}
                    onPointerMove={moveSfxDrag}
                    onPointerUp={endSfxDrag}
                    onPointerCancel={endSfxDrag}
                    onDoubleClick={() => audio.playEffect(sfx.sound, undefined, sfx.duration, sfx.volume)}
                    title={`♪ ${meta.label} · ${meta.hint} · inicio ${fmt(sfx.start)} s · ${fmt(dur)} s · vol. ${Math.round(sfx.volume * 100)}% (doble clic: escuchar)`}
                  >
                    <span className="truncate font-semibold">♪ {meta.label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] opacity-80">{fmt(sfx.start)}s</span>
                    {meta.resizable && (
                      <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-sky-300/30 hover:bg-sky-300/70" title="Arrastra para cambiar la duración"
                        onPointerDown={(e) => startSfxDrag(e, sfx, 'resize')} onPointerMove={moveSfxDrag} onPointerUp={endSfxDrag} onPointerCancel={endSfxDrag} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
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
          {lanes.length === 0 && !voice && sfxList.length === 0 && (
            <p className="px-3 py-3 text-xs text-slate-500" style={{ marginLeft: LABEL_W }}>
              Selecciona un objeto y usa los botones de Animaciones para crear clips en el cabezal.
            </p>
          )}

          {/* Guía del imán al cuadrar un efecto */}
          {snapAt !== null && (
            <div className="pointer-events-none absolute top-0 z-30 border-l border-dashed border-amber-300" style={{ left: LABEL_W + snapAt * pps, height: '100%' }}>
              <span className="absolute left-1 top-0 rounded bg-amber-300 px-1 font-mono text-[9px] text-ink-900">{fmt(snapAt)}s</span>
            </div>
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
  onDown: (e: React.PointerEvent, id: string, start: number, mode?: 'move' | 'resize') => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
}) {
  return (
    <div className="flex" style={{ height: LANE_H }} data-lane={id}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-bezel bg-ink-800 px-2 text-xs text-slate-300" style={{ width: LABEL_W }} title={label}>
        <span className="truncate">{label}</span>
      </div>
      <div className="relative border-b border-bezel" style={{ width }}>
        {clips.map((c) => {
          const spotlight = !!focusSpecOf(c);
          return (
          <div
            key={c.id}
            data-clip={c.id}
            className={`absolute top-1 flex cursor-grab flex-col justify-center overflow-hidden rounded border px-1.5 text-[10px] leading-tight ${selectedClip === c.id ? 'border-accent bg-accent-soft' : spotlight ? 'border-amber-300/70 bg-ink-600' : c.type === 'groupTransform' ? 'border-dashed border-accent/60 bg-ink-600' : c.type === 'disappear' ? 'border-rose-400/60 bg-ink-600' : 'border-bezel bg-ink-600'}`}
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
            {spotlight && (
              // Asa derecha: arrastrar cambia la duración del enfoque (una sola entrada de historial por gesto).
              <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-amber-300/40 hover:bg-amber-300/80" title="Arrastra para cambiar la duración"
                onPointerDown={(e) => onDown(e, c.id, c.duration, 'resize')} onPointerMove={onMove} onPointerUp={onUp} />
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
