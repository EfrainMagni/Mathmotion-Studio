import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Palette, AlignCenter, AlignLeft, AlignRight, ChevronDown, Copy, Italic, PenTool, Radio, RotateCw, Sparkles, MoveRight, Maximize, Trash2 } from 'lucide-react';
import { actions, defaultClipParams, store, useStore } from '../store';
import { ColorChangeFields, patchParams } from './Timeline';
import {
  ARC_LIMITS, DEFAULT_ARC, DEFAULT_TEXT_STYLE, FONT_CATALOG, isPathTool, GRID_BG_COLOR, SCENE_BG_LIMITS, resolveSceneBackground, sceneBackgroundGeometry, PLANE_STYLE_3B1B, SCALE_MAX, SCALE_MIN, SCALE_STEP, SOUND_IDS, SOUND_LABEL, STAGE_SIZES, fontInfo, fontStack, glyphIdOf,
  glyphTransformParams,
  type ClipParams, type ClipType, type FillGradient, type FontId, type FontWeight, type LineTip, type NodeStyle, type Obj2D, type PlaneArrowTips, type PlaneGeometry, type PlanePlot, type PlanePoint, type SceneBackground, type SceneBackgroundType, type SoundId, type TextAlign, type TextStyle,
} from '../types';
import { engine } from '../engine';
import { directedGlyphClips, directedTargets, entranceScope, formatGlyphList, parseGlyphList } from '../engine/glyphs';
import { preloadFont } from '../engine/fonts';
import { compileExpression, newPlot, newPoint } from '../engine/cartesianPlane';
import { CLOSED_STROKE_WIDTH_MAX, CLOSED_STROKE_WIDTH_MIN, GRADIENT_PRESETS, LINE_TIPS, gradientCss, isLinearVector, lineTips, makeGradient, newStopId } from '../engine/vector';
import { Field, NumberInput, Section, btn, btnPrimary, input } from './ui';

function toHex(css: string | undefined): string | null {
  if (!css) return null;
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase();
  const m = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  const m3 = css.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return null;
}

const MODE_TABS = [['solid', 'Sólido'], ['linear', 'Lineal'], ['radial', 'Radial']] as const;

/** Pestañas Sólido | Lineal | Radial y, para degradados, vista previa, paradas de color, ángulo y presets. */
function GradientControls({ selection, gradient, solidHex }: { selection: string; gradient: FillGradient | undefined; solidHex: string | null }) {
  const mode = gradient && gradient.mode !== 'solid' ? gradient.mode : 'solid';
  const set = (next: FillGradient | undefined) => actions.setStyle(selection, { fillGradient: next });
  const pick = (m: 'solid' | 'linear' | 'radial') => {
    if (m === 'solid') return set(undefined);
    set(gradient ? { ...gradient, mode: m } : makeGradient(m, [solidHex ?? GRADIENT_PRESETS[0].colors[0], GRADIENT_PRESETS[0].colors[1]]));
  };
  const stops = gradient?.stops ?? [];
  const setStops = (next: FillGradient['stops']) => gradient && set({ ...gradient, stops: next });
  const patchStop = (id: string, patch: Partial<FillGradient['stops'][number]>) =>
    setStops(stops.map((stop) => (stop.id === id ? { ...stop, ...patch } : stop)));
  const addStop = () => {
    const sorted = [...stops].sort((a, b) => a.offset - b.offset);
    let best = 0;
    // Se inserta en el hueco más ancho entre dos paradas consecutivas.
    for (let i = 1; i < sorted.length; i++) if (sorted[i].offset - sorted[i - 1].offset > sorted[best + 1].offset - sorted[best].offset) best = i - 1;
    const offset = Math.round((sorted[best].offset + sorted[best + 1].offset) / 2);
    setStops([...stops, { id: newStopId(), offset, color: sorted[best].color }]);
  };
  return (
    <div className="space-y-1.5">
      <div role="tablist" aria-label="Tipo de relleno" className="grid grid-cols-3 gap-0.5 rounded bg-ink-900 p-0.5">
        {MODE_TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} onClick={() => pick(id)}
            className={`rounded px-1 py-0.5 text-[11px] ${mode === id ? 'bg-accent-soft text-accent-light' : 'text-slate-400 hover:bg-ink-600'}`}>
            {label}
          </button>
        ))}
      </div>
      {gradient && mode !== 'solid' && (
        <>
          <div className="h-4 rounded border border-bezel" style={{ background: gradientCss(gradient) }} aria-label="Vista previa del degradado" />
          <ul className="space-y-1">
            {stops.map((stop) => (
              <li key={stop.id} className="flex items-center gap-1">
                <input type="color" className="h-6 w-8 cursor-pointer rounded border border-bezel bg-transparent" aria-label="Color de la parada"
                  value={toHex(stop.color) ?? '#ffffff'} onChange={(e) => patchStop(stop.id, { color: e.target.value })} />
                <NumberInput className={`${input} w-16`} value={stop.offset} min={0} max={100} step={1} ariaLabel="Posición de la parada (%)"
                  onChange={(v) => patchStop(stop.id, { offset: Math.min(100, Math.max(0, v)) })} />
                <span className="text-[11px] text-slate-500">%</span>
                <button className="ml-auto text-slate-400 hover:text-red-300 disabled:opacity-30" disabled={stops.length <= 2}
                  aria-label="Eliminar parada" title="Eliminar parada" onClick={() => setStops(stops.filter((x) => x.id !== stop.id))}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <button className={`${btn} w-full justify-center text-[11px]`} disabled={stops.length >= 16} onClick={addStop}>+ Color</button>
          {mode === 'linear' && (
            <Field label="Ángulo (°)">
              <input type="range" className="min-w-0 flex-1 accent-sky-400" min={0} max={360} step={1} aria-label="Ángulo (control deslizante)"
                value={gradient.angle} onChange={(e) => set({ ...gradient, angle: parseFloat(e.target.value) })} />
              <NumberInput className={`${input} w-16`} value={gradient.angle} min={0} max={360} step={5} ariaLabel="Ángulo del degradado"
                onChange={(v) => set({ ...gradient, angle: Math.min(360, Math.max(0, v)) })} />
            </Field>
          )}
        </>
      )}
      <div className="grid grid-cols-2 gap-1" aria-label="Presets de degradado">
        {GRADIENT_PRESETS.map((preset) => (
          <button key={preset.id} className={`${btn} justify-start gap-1.5 text-[11px]`} title={preset.label}
            onClick={() => set(makeGradient(mode === 'radial' ? 'radial' : 'linear', preset.colors, gradient?.angle ?? 0))}>
            <span className="h-3 w-5 shrink-0 rounded-sm border border-bezel" style={{ background: `linear-gradient(90deg, ${preset.colors[0]}, ${preset.colors[1]})` }} />
            <span className="truncate">{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const WEIGHT_LABEL: Record<FontWeight, string> = { 400: 'Regular 400', 600: 'SemiBold 600', 700: 'Bold 700' };
const ALIGNS: { id: TextAlign; label: string; icon: typeof AlignLeft }[] = [
  { id: 'left', label: 'Izquierda', icon: AlignLeft },
  { id: 'center', label: 'Centro', icon: AlignCenter },
  { id: 'right', label: 'Derecha', icon: AlignRight },
];

/** Sección «Carácter» (estilo Illustrator) de los objetos de texto. */
function TextTypography({ obj }: { obj: Obj2D }) {
  const style: TextStyle = obj.vector?.textStyle ?? DEFAULT_TEXT_STYLE;
  const info = fontInfo(style.fontFamily);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const sample = (obj.vector?.text ?? '').trim().slice(0, 18) || 'Aa Ββ 123';

  useEffect(() => {
    if (!open) return;
    for (const f of FONT_CATALOG) void preloadFont(f.id);
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const apply = (patch: Partial<TextStyle>) => {
    const next = { ...style, ...patch };
    const f = fontInfo(next.fontFamily);
    if (!f.weights.includes(next.fontWeight)) next.fontWeight = f.weights.reduce((a, b) => (Math.abs(b - next.fontWeight) < Math.abs(a - next.fontWeight) ? b : a));
    if (!f.italic) next.italic = false;
    void preloadFont(next.fontFamily, next.fontWeight, next.italic);
    actions.editVector(obj, { textStyle: next });
  };

  const toggle = (on: boolean) => `h-6 min-w-6 rounded border px-1.5 text-[11px] disabled:opacity-30 ${on ? 'border-accent bg-accent-soft text-accent-light' : 'border-bezel bg-ink-700 text-slate-200 hover:bg-ink-600'}`;

  return (
    <div className="flex flex-col gap-1.5 rounded border border-bezel p-1.5" aria-label="Carácter">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Carácter</div>
      <div ref={box} className="relative">
        <button type="button" className={`${input} flex items-center justify-between gap-2 text-left`} aria-haspopup="listbox" aria-expanded={open}
          aria-label="Tipografía" onClick={() => setOpen(!open)}>
          <span className="truncate text-sm" style={{ fontFamily: fontStack(info.id) }}>{info.id}</span>
          <ChevronDown size={12} className="shrink-0 text-slate-400" />
        </button>
        {open && (
          <ul role="listbox" className="absolute left-0 right-0 z-30 mt-0.5 max-h-72 overflow-auto rounded border border-bezel bg-ink-900 py-0.5 shadow-lg">
            {(['Divulgación', 'Letra corrida'] as const).map((category) => (
              <li key={category} role="presentation">
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {category === 'Divulgación' ? 'Divulgación científica' : 'Letra corrida'}
                </div>
                <ul role="presentation">
                  {FONT_CATALOG.filter((f) => f.category === category).map((f) => (
                    <li key={f.id} role="option" aria-selected={f.id === style.fontFamily}>
                      <button type="button" className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-white/10 ${f.id === style.fontFamily ? 'bg-accent-soft' : ''}`}
                        onClick={() => { apply({ fontFamily: f.id as FontId }); setOpen(false); }}>
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] text-slate-300">{f.id}</span>
                          <span className="block truncate text-lg leading-tight text-slate-50" style={{ fontFamily: fontStack(f.id) }}>{sample}</span>
                        </span>
                        <span className="shrink-0 rounded bg-ink-700 px-1 text-[10px] text-slate-400">{f.category}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="Peso">
        <select className={input} aria-label="Peso" value={style.fontWeight}
          onChange={(event) => apply({ fontWeight: Number(event.target.value) as FontWeight })}>
          {info.weights.map((w) => <option key={w} value={w}>{WEIGHT_LABEL[w]}</option>)}
        </select>
        <button type="button" className={toggle(style.italic)} disabled={!info.italic} aria-pressed={style.italic}
          title={info.italic ? 'Cursiva / Italic' : 'Esta fuente no tiene cursiva'} aria-label="Cursiva" onClick={() => apply({ italic: !style.italic })}>
          <Italic size={12} />
        </button>
      </Field>
      <Field label="Alineación">
        {ALIGNS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={toggle(style.align === id)} aria-pressed={style.align === id} title={label} aria-label={label}
            onClick={() => apply({ align: id })}>
            <Icon size={12} />
          </button>
        ))}
      </Field>
      <Field label="Espaciado (px)">
        <NumberInput className={`${input} w-20`} value={style.letterSpacing} min={-20} max={100} step={0.5}
          onChange={(v) => apply({ letterSpacing: v })} ariaLabel="Espaciado entre letras" />
      </Field>
    </div>
  );
}

function LineTipFields({ object }: { object: Obj2D }) {
  if (!object.vector) return null;
  const tips = lineTips(object.vector);
  const ends = [
    { key: 'startTip', label: 'Punta Inicio', value: tips.start },
    { key: 'endTip', label: 'Punta Fin', value: tips.end },
  ] as const;

  return (
    <>
      {ends.map(({ key, label, value }) => (
        <Field key={key} label={label}>
          <select className={input} aria-label={label} value={value}
            onChange={(event) => actions.editVector(object, { [key]: event.target.value as LineTip })}>
            {Object.entries(LINE_TIPS).map(([tip, name]) => <option key={tip} value={tip}>{name}</option>)}
          </select>
        </Field>
      ))}
      <Field label="Escala de punta">
        <NumberInput className={`${input} w-20`} value={tips.scale} min={0.5} max={3} step={0.1}
          onChange={(tipScale) => actions.editVector(object, { tipScale })} />
      </Field>
    </>
  );
}

const ARC_PRESETS = [
  { label: '90°', sweep: -90 }, { label: '180°', sweep: -180 }, { label: '270°', sweep: -270 }, { label: '360°', sweep: -360 },
] as const;

/** Arco circular / flecha curva: ángulo inicial y barrido (también editables arrastrando sus extremos en el lienzo). */
function ArcFields({ object }: { object: Obj2D }) {
  const arc = object.vector?.arc ?? DEFAULT_ARC;
  const group = useRef<symbol>(Symbol('arc'));
  const restart = () => { group.current = Symbol('arc'); };
  const set = (patch: Partial<typeof arc>, grouped = false) => {
    const startAngle = Math.min(ARC_LIMITS.startAngle.max, Math.max(ARC_LIMITS.startAngle.min, patch.startAngle ?? arc.startAngle));
    const sweep = Math.min(ARC_LIMITS.sweep.max, Math.max(ARC_LIMITS.sweep.min, patch.sweep ?? arc.sweep));
    if (startAngle === arc.startAngle && sweep === arc.sweep) return;
    actions.editVector(object, { arc: { startAngle, sweep } }, grouped ? group.current : undefined);
  };
  const row = (key: 'startAngle' | 'sweep', label: string) => (
    <div className="flex flex-col gap-0.5">
      <Field label={label}>
        <NumberInput className={`${input} w-16`} value={arc[key]} min={ARC_LIMITS[key].min} max={ARC_LIMITS[key].max} step={1}
          ariaLabel={`${label} (grados)`} onChange={(value) => set({ [key]: value } as Partial<typeof arc>)} />
      </Field>
      <input type="range" className="w-full accent-accent" aria-label={label} min={ARC_LIMITS[key].min} max={ARC_LIMITS[key].max} step={1}
        value={arc[key]} onPointerDown={restart} onKeyDown={restart} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<typeof arc>, true)} />
    </div>
  );
  return (
    <div className={BLOCK}>
      <div className={BLOCK_HEAD}><span>Arco circular</span></div>
      {row('startAngle', 'Ángulo inicial (°)')}
      {row('sweep', 'Barrido (°)')}
      <div className="grid grid-cols-5 gap-1" role="group" aria-label="Barridos rápidos">
        {ARC_PRESETS.map(({ label, sweep }) => (
          <button key={label} type="button" className={`${btn} justify-center px-0 text-[10px] ${Math.abs(arc.sweep) === -sweep ? 'border-accent text-accent-light' : ''}`}
            title={`Barrido de ${label} en el sentido actual`} onClick={() => set({ sweep: arc.sweep > 0 ? -sweep : sweep })}>
            {label}
          </button>
        ))}
        <button type="button" className={`${btn} justify-center px-0 text-[10px]`} title="Invertir sentido (horario ↔ antihorario)"
          aria-label="Invertir sentido del arco" onClick={() => set({ sweep: -arc.sweep })}>⇄</button>
      </div>
      <p className="text-[10px] text-slate-500">Positivo = antihorario · negativo = horario. Arrastra los extremos en el lienzo.</p>
    </div>
  );
}

/** Trazado Bézier: tipo del nodo activo (Selección Directa) y apertura/cierre del camino. */
function PathNodeFields({ object }: { object: Obj2D }) {
  const pathNode = useStore((s) => s.ui.pathNode);
  const nodes = object.vector?.nodes ?? [];
  const node = pathNode !== null ? nodes[pathNode] : undefined;
  const closed = !!object.vector?.closed;
  const kinds = [['corner', 'Ángulo recto'], ['smooth', 'Curva suave']] as const;
  return (
    <div className={BLOCK}>
      <div className={BLOCK_HEAD}><span>Trazado · {nodes.length} nodos</span></div>
      {node && pathNode !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">Nodo {pathNode + 1}</span>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Tipo de nodo">
            {kinds.map(([type, label]) => (
              <button key={type} type="button" role="radio" aria-checked={node.type === type}
                className={`${btn} justify-center px-1 text-[11px] ${node.type === type ? 'border-accent text-accent-light' : ''}`}
                onClick={() => { if (node.type !== type) actions.togglePathNode(object.id, pathNode); }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">Con Selección Directa (A) elige un nodo; doble clic alterna ángulo ↔ curva.</p>
      )}
      <div className="flex items-center justify-between text-[11px] text-slate-300">
        <span>Trazado cerrado</span>
        <Switch label="Trazado cerrado" checked={closed}
          onChange={(on) => { if (on !== closed && (!on || nodes.length > 2)) actions.setPathNodes(object, nodes, undefined, { closed: on }); }} />
      </div>
    </div>
  );
}

const BLOCK = 'flex flex-col gap-1.5 rounded border border-bezel p-1.5';
const BLOCK_HEAD = 'flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400';
const DEFAULT_FILL = '#58C4DD';
const DEFAULT_STROKE = '#FFFFFF';
const clampWidth = (v: number) => Math.min(CLOSED_STROKE_WIDTH_MAX, Math.max(CLOSED_STROKE_WIDTH_MIN, v));

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-ink-600'}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${checked ? 'left-3.5' : 'left-0.5'}`} />
    </button>
  );
}

/**
 * Bloques independientes «Relleno» y «Trazo / Contorno» (estilo Illustrator). Cada uno se activa por separado:
 * p. ej. relleno azul semitransparente con borde blanco o amarillo, como en Manim (`set_fill` + `set_stroke`).
 */
function PaintBlocks({ selection, style, fill, stroke, strokeWidth, linear }: {
  selection: string; style: NodeStyle; fill: string | undefined; stroke: string | undefined; strokeWidth: number; linear: boolean;
}) {
  // Últimos colores usados, para que reactivar relleno/trazo recupere el color anterior.
  const lastFill = useRef<string | null>(null);
  const lastStroke = useRef<string | null>(null);
  const dragGroup = useRef<symbol | undefined>(undefined);
  const gradient = style.fillGradient && style.fillGradient.mode !== 'solid' ? style.fillGradient : undefined;
  const fillOn = !!gradient || (!!fill && fill !== 'none');
  const strokeOn = !!stroke && stroke !== 'none' && strokeWidth > 0;
  const fillHex = toHex(fill);
  const strokeHex = toHex(stroke);
  if (fillOn && fillHex) lastFill.current = fillHex;
  if (strokeOn && strokeHex) lastStroke.current = strokeHex;
  const set = (patch: Partial<NodeStyle>, group?: symbol) => actions.setStyle(selection, patch, group);
  const fillOpacity = style.fillOpacity ?? 1;
  const width = strokeOn ? strokeWidth : style.strokeWidth ?? 4;

  const toggleFill = (on: boolean) => on
    ? set({ fill: lastFill.current ?? DEFAULT_FILL })
    : set({ fill: 'none', fillGradient: undefined });
  const toggleStroke = (on: boolean) => on
    ? set({ stroke: lastStroke.current ?? DEFAULT_STROKE, strokeWidth: clampWidth(strokeWidth > 0 ? strokeWidth : 4) })
    : set({ stroke: 'none' });
  const slider = (onValue: (v: number, group: symbol) => void) => ({
    onPointerDown: () => { dragGroup.current = Symbol('slider'); },
    onPointerUp: () => { dragGroup.current = undefined; },
    onChange: (e: ChangeEvent<HTMLInputElement>) => onValue(parseFloat(e.target.value), dragGroup.current ?? Symbol('slider')),
  });

  return (
    <>
      {!linear && (
        <div className={BLOCK} aria-label="Relleno">
          <div className={BLOCK_HEAD}>
            <span>Relleno</span>
            <Switch label="Activar relleno" checked={fillOn} onChange={toggleFill} />
          </div>
          {fillOn && (
            <>
              <GradientControls selection={selection} gradient={style.fillGradient} solidHex={fillHex} />
              {!gradient && (
                <Field label="Color">
                  <input type="color" aria-label="Color de relleno" value={fillHex ?? DEFAULT_FILL.toLowerCase()}
                    className="h-6 w-9 cursor-pointer rounded border border-bezel bg-transparent"
                    onChange={(e) => set({ fill: e.target.value })} />
                  {style.fill !== undefined && (
                    <button className="text-[11px] text-accent-light underline" title="Volver al valor original"
                      onClick={() => set({ fill: undefined })}>original</button>
                  )}
                </Field>
              )}
              <Field label="Opacidad (%)">
                <input type="range" className="min-w-0 flex-1 accent-sky-400" min={0} max={100} step={1} aria-label="Opacidad de relleno (control deslizante)"
                  value={Math.round(fillOpacity * 100)} {...slider((v, g) => set({ fillOpacity: v / 100 }, g))} />
                <NumberInput className={`${input} w-16`} value={Math.round(fillOpacity * 100)} min={0} max={100} step={5} ariaLabel="Opacidad de relleno"
                  onChange={(v) => set({ fillOpacity: Math.min(100, Math.max(0, v)) / 100 })} />
              </Field>
            </>
          )}
        </div>
      )}
      {linear && <GradientControls selection={selection} gradient={style.fillGradient} solidHex={strokeHex} />}

      <div className={BLOCK} aria-label="Trazo / Contorno">
        <div className={BLOCK_HEAD}>
          <span>Trazo / Contorno</span>
          <Switch label="Activar trazo" checked={strokeOn} onChange={toggleStroke} />
        </div>
        {strokeOn && (
          <>
            {!(linear && gradient) && (
              <Field label="Color">
                <input type="color" aria-label="Color de trazo" value={strokeHex ?? '#ffffff'}
                  className="h-6 w-9 cursor-pointer rounded border border-bezel bg-transparent"
                  onChange={(e) => set({ stroke: e.target.value })} />
                {['#FFFFFF', '#FFFF00', '#58C4DD', '#FC6255'].map((c) => (
                  <button key={c} type="button" title={c} aria-label={`Trazo ${c}`} onClick={() => set({ stroke: c })}
                    className="h-4 w-4 shrink-0 rounded-sm border border-bezel" style={{ background: c }} />
                ))}
              </Field>
            )}
            <Field label="Grosor (px)">
              <input type="range" className="min-w-0 flex-1 accent-sky-400" aria-label="Grosor de trazo (control deslizante)"
                min={CLOSED_STROKE_WIDTH_MIN} max={CLOSED_STROKE_WIDTH_MAX} step={0.5} value={clampWidth(width)}
                {...slider((v, g) => set({ strokeWidth: clampWidth(v) }, g))} />
              <NumberInput className={`${input} w-16`} value={width} min={CLOSED_STROKE_WIDTH_MIN} max={CLOSED_STROKE_WIDTH_MAX} step={0.5}
                ariaLabel="Grosor de trazo" onChange={(v) => set({ strokeWidth: clampWidth(v) })} />
            </Field>
            <Field label="Estilo">
              <select className={input} aria-label="Estilo de línea" value={style.lineStyle ?? 'solid'} onChange={(event) => {
                const value = event.target.value;
                set({ lineStyle: value === 'dashed' || value === 'dotted' ? value : 'solid' });
              }}>
                <option value="solid">Continua</option>
                <option value="dashed">Discontinua</option>
                <option value="dotted">Punteada</option>
              </select>
            </Field>
            {(style.lineStyle === 'dashed' || style.lineStyle === 'dotted') && (
              <Field label="Separación (px)">
                <NumberInput className={`${input} w-20`} min={0.1} step={0.5}
                  value={style.dashGap ?? (width || 1) * (style.lineStyle === 'dashed' ? 2 : 2.5)}
                  onChange={(dashGap) => set({ dashGap })} />
              </Field>
            )}
            {linear ? (
              <Field label="Remate de extremo">
                <select className={input} aria-label="Remate de extremo" value={style.lineCap ?? ''} onChange={(event) => {
                  const value = event.target.value;
                  set({ lineCap: value === 'butt' || value === 'round' ? value : undefined });
                }}>
                  <option value="">Original</option>
                  <option value="butt">Plano / Butt</option>
                  <option value="round">Redondeado / Round</option>
                </select>
              </Field>
            ) : (
              <Field label="Esquinas">
                <select className={input} aria-label="Unión de esquinas" value={style.lineJoin ?? 'miter'}
                  onChange={(event) => set({ lineJoin: event.target.value === 'round' ? 'round' : 'miter' })}>
                  <option value="miter">Afilada / Miter</option>
                  <option value="round">Redondeada / Round</option>
                </select>
              </Field>
            )}
            {style.stroke !== undefined && (
              <button className="self-start text-[11px] text-accent-light underline" title="Volver al trazo original"
                onClick={() => set({ stroke: undefined, strokeWidth: undefined, lineStyle: undefined, dashGap: undefined, lineJoin: undefined })}>
                trazo original
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Inspector() {
  const selection = useStore((s) => s.ui.selection);
  const project = useStore((s) => s.project);
  useStore((s) => s.ui.treeVersion);
  const multiCount = useStore((s) => s.ui.multiSelection.length);

  if (!selection) {
    return (
      <Section title="Inspector">
        <p className="text-xs text-slate-500">Selecciona un objeto en el lienzo o en el árbol.</p>
      </Section>
    );
  }
  const info = engine.runtime?.getNodeInfo(selection) ?? null;
  const obj = project.objects.find((o) => o.id === (info?.objId ?? selection));
  if (!info || !obj) {
    return (
      <Section title="Inspector">
        <p className="text-xs text-slate-500">El elemento seleccionado ya no existe.</p>
      </Section>
    );
  }
  const style = project.styles[selection] ?? {};
  const paint = engine.runtime?.getPaint(selection) ?? null;
  const fill = style.fill ?? paint?.fill;
  const stroke = style.stroke ?? paint?.stroke;
  const strokeWidth = style.strokeWidth ?? paint?.strokeWidth ?? 0;
  const scale = info.isRoot ? obj.scale : style.scale ?? 1;
  const center = (axis: 'x' | 'y') => {
    const { w, h } = STAGE_SIZES[project.format];
    actions.updateObject(obj.id, axis === 'x' ? { x: w / 2 } : { y: h / 2 });
  };

  const setScale = (v: number) => (info.isRoot ? actions.updateObject(obj.id, { scale: v }) : actions.setStyle(selection, { scale: v }));

  return (
    <Section title="Inspector">
      <div className="flex items-start gap-1.5 rounded bg-ink-900 p-1.5 text-xs">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-100" title={info.name}>{info.name}</div>
          <div className="font-mono text-[10px] text-slate-500">
            {selection} · {info.tag}
          </div>
        </div>
        <button type="button" className={`${btn} shrink-0 gap-1 px-1.5 text-[11px]`} onClick={() => actions.duplicateSelection()}
          title={multiCount > 1 ? `Duplicar ${multiCount} objetos (Ctrl+D)` : 'Duplicar (Ctrl+D)'} aria-label="Duplicar (Ctrl+D)">
          <Copy size={12} /> Duplicar
        </button>
      </div>
      {multiCount > 1 && (
        <p className="rounded border border-accent/40 bg-accent-soft px-1.5 py-1 text-[11px] text-accent-light" aria-live="polite">
          {multiCount} objetos seleccionados · arrástralos o usa las flechas para moverlos juntos. El inspector muestra el último.
        </p>
      )}

      {obj.plane ? null : paint ? (
        <PaintBlocks selection={selection} style={style} fill={fill} stroke={stroke} strokeWidth={strokeWidth}
          linear={info.isRoot && isLinearVector(obj.vector)} />
      ) : (
        <p className="text-[11px] text-slate-500">Este elemento no tiene geometría con relleno ni trazo.</p>
      )}

      <Field label="Opacidad (%)">
        <NumberInput className={`${input} w-20`} value={(style.opacity ?? 1) * 100} min={0} max={100} step={5}
          onChange={(value) => actions.setStyle(selection, { opacity: value / 100 })} />
      </Field>

      {isPathTool(obj.vector?.tool) && <PathNodeFields object={obj} />}
      {obj.vector?.tool === 'arc' && <ArcFields object={obj} />}
      {isLinearVector(obj.vector) && <LineTipFields object={obj} />}
      {obj.vector?.tool === 'text' && (
        <Field label="Contenido del texto">
          <input className={input} value={obj.vector.text ?? ''} maxLength={250}
            onChange={(event) => actions.editVector(obj, { text: event.target.value })} />
        </Field>
      )}
      {obj.vector?.tool === 'text' && <TextTypography obj={obj} />}

      <Field label="Escala">
        <input type="range" className="min-w-0 flex-1 accent-sky-400" aria-label="Escala (control deslizante)"
          min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP} value={Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale))}
          onChange={(e) => setScale(parseFloat(e.target.value))} />
        <NumberInput className={`${input} w-20`} value={scale} min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP} onChange={setScale} ariaLabel="Escala" />
      </Field>

      {info.isRoot && (
        <Field label="Rotación (°)">
          <NumberInput className={`${input} w-20`} value={obj.rotation} step={5} onChange={(v) => actions.updateObject(obj.id, { rotation: v })} />
        </Field>
      )}

      {info.isRoot && (
        <div className="flex gap-2">
          <button
            className={btn}
            onClick={() => {
              const { w, h } = STAGE_SIZES[store.getState().project.format];
              actions.updateObject(obj.id, {
                x: w / 2,
                y: h / 2,
                rotation: 0,
                scale: obj.kind === 'formula' ? Math.min((w * 0.7) / obj.bw, (h * 0.35) / obj.bh) : Math.min(w / obj.bw, h / obj.bh),
              });
            }}
            title="Centra el objeto y lo encaja completo en el lienzo"
          >
            <Maximize size={13} /> Ajustar al lienzo
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Alineación y orden">
        <button className={btn} onClick={() => center('x')}>Centrar horizontal</button>
        <button className={btn} onClick={() => center('y')}>Centrar vertical</button>
        <button className={btn} onClick={() => actions.orderObject(obj.id, true)}>Traer al frente</button>
        <button className={btn} onClick={() => actions.orderObject(obj.id, false)}>Enviar atrás</button>
        <button className={btn} onClick={() => actions.duplicateSelection()} title="Ctrl+D">Duplicar objeto</button>
      </div>

      {!info.isRoot && (
        <button
          className={btn}
          onClick={() => actions.setStyle(selection, { fill: undefined, fillGradient: undefined, fillOpacity: undefined, stroke: undefined, strokeWidth: undefined, lineStyle: undefined, dashGap: undefined, lineCap: undefined, lineJoin: undefined, opacity: undefined, scale: undefined, tx: undefined, ty: undefined })}
        >
          Restablecer estilo y posición
        </button>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ plano cartesiano

const compact = 'min-h-5 w-full rounded border border-bezel bg-ink-900 px-1 py-0 text-[11px] text-slate-100 outline-none focus:border-accent disabled:opacity-40';
const colorInput = 'h-5 w-8 shrink-0 cursor-pointer rounded border border-bezel bg-transparent disabled:opacity-30';

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-[10px] text-slate-400">
      <span className="truncate">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-300">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}

/** Campo de texto que confirma al salir o con Intro (evita una entrada de historial por cada tecla). */
function CommitInput({ value, onCommit, label, placeholder, invalid, className }: {
  value: string; onCommit: (value: string) => void; label: string; placeholder?: string; invalid?: boolean; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input className={`${className ?? compact} ${invalid ? 'border-rose-400/70' : ''}`} aria-label={label} aria-invalid={invalid || undefined}
      placeholder={placeholder} value={draft ?? value} spellCheck={false}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
  );
}

/** Número opcional (vacío = valor por defecto del plano). */
function OptionalNumber({ value, placeholder, label, onCommit }: {
  value: number | undefined; placeholder: string; label: string; onCommit: (value: number | undefined) => void;
}) {
  return (
    <CommitInput label={label} placeholder={placeholder} value={value === undefined ? '' : String(value)}
      onCommit={(text) => {
        if (!text.trim()) return onCommit(undefined);
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onCommit(parsed);
      }} />
  );
}

/** Crea un clip independiente para una gráfica o un punto del plano, en el instante actual del cabezal. */
function addPlaneClip(object: Obj2D, subElementId: string, type: ClipType, duration: number, extra: Record<string, string> = {}) {
  actions.addClip({
    targetId: object.id, type, start: Math.round(store.getState().ui.time * 100) / 100, duration,
    parameters: { ...extra, subElementId }, sound: null,
  });
}

/** Quita los clips de un sub-elemento eliminado (el elemento se borra primero: un solo paso de historial). */
function removePlaneClips(object: Obj2D, subElementId: string) {
  for (const clip of store.getState().project.clips) {
    if (clip.targetId === object.id && clip.parameters.subElementId === subElementId) actions.removeClip(clip.id);
  }
}

const PLANE_HEADING = 'pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500';

/** Inspector del plano cartesiano (`NumberPlane`): intervalos, ejes y flechas, cuadrícula, números y marcas. */
function PlaneInspector() {
  const object = useStore((s) => {
    const id = s.ui.selection;
    return id && !id.includes('.') ? s.project.objects.find((o) => o.id === id && o.plane) ?? null : null;
  });
  if (!object?.plane) return null;
  const p = object.plane;
  const set = (patch: Partial<PlaneGeometry>) => actions.editPlane(object, patch);
  const n = (label: string, key: keyof PlaneGeometry, extra: { min?: number; max?: number; step?: number } = {}) => (
    <Mini label={label}>
      <NumberInput className={compact} ariaLabel={label} value={p[key] as number} step={extra.step ?? 0.5}
        min={extra.min} max={extra.max} onChange={(value) => set({ [key]: value })} />
    </Mini>
  );
  const eps = 0.001;
  return (
    <Section title="Plano cartesiano">
      <div className={PLANE_HEADING}>Intervalos</div>
      <div className="grid grid-cols-3 gap-1">
        {n('X mín', 'xMin', { max: p.xMax - eps })}
        {n('X máx', 'xMax', { min: p.xMin + eps })}
        {n('Paso X', 'xStep', { min: eps, step: 0.25 })}
        {n('Y mín', 'yMin', { max: p.yMax - eps })}
        {n('Y máx', 'yMax', { min: p.yMin + eps })}
        {n('Paso Y', 'yStep', { min: eps, step: 0.25 })}
        {n('Subdiv.', 'subdivisions', { min: 1, max: 10, step: 1 })}
        {n('Ancho', 'width', { min: 20, step: 10 })}
        {n('Alto', 'height', { min: 20, step: 10 })}
      </div>

      <div className={PLANE_HEADING}>Ejes y flechas</div>
      <div className="flex items-center justify-between gap-2">
        <Toggle label="Mostrar ejes" checked={p.showAxes} onChange={(showAxes) => set({ showAxes })} />
        <input type="color" className={colorInput} aria-label="Color de ejes" value={p.axisColor}
          onChange={(event) => set({ axisColor: event.target.value })} />
        <NumberInput className={`${compact} w-12`} ariaLabel="Grosor de ejes" value={p.axisWidth} min={0} step={0.2}
          onChange={(axisWidth) => set({ axisWidth })} />
      </div>
      <Field label="Puntas">
        <select className={compact} aria-label="Puntas de flecha" value={p.arrowTips}
          onChange={(event) => set({ arrowTips: event.target.value as PlaneArrowTips })}>
          <option value="positive">Positivas</option>
          <option value="both">Ambos lados</option>
          <option value="none">Sin puntas</option>
        </select>
      </Field>
      <div className="flex items-center gap-1.5">
        <Toggle label="Etiquetas" checked={p.showAxisLabels} onChange={(showAxisLabels) => set({ showAxisLabels })} />
        <input className={compact} aria-label="Etiqueta del eje x" value={p.xLabel} maxLength={12} disabled={!p.showAxisLabels}
          onChange={(event) => set({ xLabel: event.target.value })} />
        <input className={compact} aria-label="Etiqueta del eje y" value={p.yLabel} maxLength={12} disabled={!p.showAxisLabels}
          onChange={(event) => set({ yLabel: event.target.value })} />
      </div>

      <div className={PLANE_HEADING}>Cuadrícula</div>
      {([
        ['Principal', 'showGrid', 'gridColor', 'gridWidth', 'gridOpacity'],
        ['Subcuadrícula', 'showSubGrid', 'subGridColor', 'subGridWidth', 'subGridOpacity'],
      ] as const).map(([label, show, color, width, opacity]) => (
        <div key={show} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Toggle label={label} checked={p[show]} onChange={(value) => set({ [show]: value })} />
            <input type="color" className={colorInput} aria-label={`Color de ${label.toLowerCase()}`} value={p[color]}
              onChange={(event) => set({ [color]: event.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Mini label="Grosor">
              <NumberInput className={compact} ariaLabel={`Grosor de ${label.toLowerCase()}`} value={p[width]} min={0} step={0.1}
                onChange={(value) => set({ [width]: value })} />
            </Mini>
            <Mini label="Opacidad (%)">
              <NumberInput className={compact} ariaLabel={`Opacidad de ${label.toLowerCase()}`} value={p[opacity] * 100} min={0} max={100} step={5}
                onChange={(value) => set({ [opacity]: value / 100 })} />
            </Mini>
          </div>
        </div>
      ))}
      <button className={btn} onClick={() => set({ ...PLANE_STYLE_3B1B })}
        title="Restaura los colores clásicos cian / blanco de 3Blue1Brown">
        Estilo 3B1B
      </button>

      <div className={PLANE_HEADING}>Números y marcas</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <Toggle label="Marcas (ticks)" checked={p.showTicks} onChange={(showTicks) => set({ showTicks })} />
        <Toggle label="Números" checked={p.showNumbers} onChange={(showNumbers) => set({ showNumbers })} />
        <Toggle label="Mostrar 0 en origen" checked={p.showOriginZero} onChange={(showOriginZero) => set({ showOriginZero })} />
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Mini label="Largo marca">
          <NumberInput className={compact} ariaLabel="Largo de marca" value={p.tickLength} min={0} step={1} onChange={(tickLength) => set({ tickLength })} />
        </Mini>
        <Mini label="Tamaño núm.">
          <NumberInput className={compact} ariaLabel="Tamaño de números" value={p.numberSize} min={4} step={1} onChange={(numberSize) => set({ numberSize })} />
        </Mini>
        <Mini label="Color núm.">
          <input type="color" className={colorInput} aria-label="Color de números" value={p.numberColor}
            onChange={(event) => set({ numberColor: event.target.value })} />
        </Mini>
      </div>

      <div className={PLANE_HEADING}>Funciones f(x)</div>
      {(p.plots ?? []).map((plot) => {
        const patch = (change: Partial<PlanePlot>) =>
          set({ plots: (p.plots ?? []).map((entry) => (entry.id === plot.id ? { ...entry, ...change } : entry)) });
        return (
          <div key={plot.id} className="space-y-1 rounded border border-bezel p-1">
            <div className="flex items-center gap-1">
              <input type="checkbox" aria-label={`Mostrar ${plot.id}`} checked={plot.visible} onChange={(event) => patch({ visible: event.target.checked })} />
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{plot.id}</span>
              <CommitInput label={`Expresión de ${plot.id}`} value={plot.expression} placeholder="2*x + 1"
                invalid={!compileExpression(plot.expression)} onCommit={(expression) => patch({ expression })} />
              <input type="color" className={colorInput} aria-label={`Color de ${plot.id}`} value={plot.color}
                onChange={(event) => patch({ color: event.target.value })} />
              <button className="shrink-0 text-slate-400 hover:text-rose-300" title="Eliminar función" aria-label={`Eliminar ${plot.id}`}
                onClick={() => {
                  set({ plots: (p.plots ?? []).filter((entry) => entry.id !== plot.id) });
                  removePlaneClips(object, `plot:${plot.id}`);
                }}>
                <Trash2 size={12} />
              </button>
            </div>
            {!compileExpression(plot.expression) && (
              <p className="text-[10px] text-rose-300">Expresión no válida (usa x, + - * / ^, sin, cos, tan, sqrt, abs, ln, log, exp, pi, e).</p>
            )}
            <div className="grid grid-cols-3 gap-1">
              <Mini label="Grosor">
                <NumberInput className={compact} ariaLabel={`Grosor de ${plot.id}`} value={plot.width} min={0.5} step={0.5} onChange={(width) => patch({ width })} />
              </Mini>
              <Mini label="x desde">
                <OptionalNumber label={`x inicial de ${plot.id}`} placeholder={String(p.xMin)} value={plot.xStart} onCommit={(xStart) => patch({ xStart })} />
              </Mini>
              <Mini label="x hasta">
                <OptionalNumber label={`x final de ${plot.id}`} placeholder={String(p.xMax)} value={plot.xEnd} onCommit={(xEnd) => patch({ xEnd })} />
              </Mini>
            </div>
            <div className="flex gap-1" role="group" aria-label={`Animar ${plot.id}`}>
              <button className={`${btn} flex-1`} title="Crea un clip Create de esta gráfica en el cabezal"
                onClick={() => addPlaneClip(object, `plot:${plot.id}`, 'draw', 1.5)}>Animar (Create)</button>
              <button className={`${btn} flex-1`} title="Crea un clip Indicate de esta gráfica en el cabezal"
                onClick={() => addPlaneClip(object, `plot:${plot.id}`, 'indicate', 1)}>Indicate</button>
              <button className={`${btn} flex-1`} title="Cambiar Color permanente de esta gráfica (edítalo en la línea de tiempo)"
                onClick={() => addPlaneClip(object, `plot:${plot.id}`, 'colorChange', 1)}>Color</button>
            </div>
          </div>
        );
      })}
      <button className={btn} disabled={(p.plots?.length ?? 0) >= 50} onClick={() => set({ plots: [...(p.plots ?? []), newPlot(p)] })}>
        + Función / Recta f(x)
      </button>

      <div className={PLANE_HEADING}>Puntos (x, y)</div>
      {(p.points ?? []).map((point) => {
        const patch = (change: Partial<PlanePoint>) =>
          set({ points: (p.points ?? []).map((entry) => (entry.id === point.id ? { ...entry, ...change } : entry)) });
        return (
          <div key={point.id} className="space-y-1 rounded border border-bezel p-1">
            <div className="flex items-center gap-1">
              <input type="checkbox" aria-label={`Mostrar ${point.id}`} checked={point.visible} onChange={(event) => patch({ visible: event.target.checked })} />
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{point.id}</span>
              <NumberInput className={compact} ariaLabel={`x de ${point.id}`} value={point.x} step={0.5} onChange={(x) => patch({ x })} />
              <NumberInput className={compact} ariaLabel={`y de ${point.id}`} value={point.y} step={0.5} onChange={(y) => patch({ y })} />
              <input type="color" className={colorInput} aria-label={`Color de ${point.id}`} value={point.color}
                onChange={(event) => patch({ color: event.target.value })} />
              <button className="shrink-0 text-slate-400 hover:text-rose-300" title="Eliminar punto" aria-label={`Eliminar ${point.id}`}
                onClick={() => {
                  set({ points: (p.points ?? []).filter((entry) => entry.id !== point.id) });
                  removePlaneClips(object, `point:${point.id}`);
                }}>
                <Trash2 size={12} />
              </button>
            </div>
            <div className="grid grid-cols-[3.5rem_1fr] items-end gap-1">
              <Mini label="Radio">
                <NumberInput className={compact} ariaLabel={`Radio de ${point.id}`} value={point.radius} min={1} step={1} onChange={(radius) => patch({ radius })} />
              </Mini>
              <Mini label="Etiqueta">
                <CommitInput label={`Etiqueta de ${point.id}`} value={point.label ?? ''} placeholder="A" onCommit={(label) => patch({ label: label.trim() ? label : undefined })} />
              </Mini>
            </div>
            <Toggle label="Líneas guía a los ejes" checked={point.showGuideLines === true}
              onChange={(showGuideLines) => patch({ showGuideLines: showGuideLines || undefined })} />
            <div className="flex gap-1" role="group" aria-label={`Animar ${point.id}`}>
              <button className={`${btn} flex-1`} title="Crea un clip de brotar (Pop) de este punto en el cabezal"
                onClick={() => addPlaneClip(object, `point:${point.id}`, 'appear', 0.6, { mode: 'pop' })}>Brotar (Pop)</button>
              <button className={`${btn} flex-1`} title="Crea un clip Indicate de este punto en el cabezal"
                onClick={() => addPlaneClip(object, `point:${point.id}`, 'indicate', 1)}>Indicate</button>
              <button className={`${btn} flex-1`} title="Cambiar Color permanente de este punto (edítalo en la línea de tiempo)"
                onClick={() => addPlaneClip(object, `point:${point.id}`, 'colorChange', 1)}>Color</button>
            </div>
          </div>
        );
      })}
      <button className={btn} disabled={(p.points?.length ?? 0) >= 200} onClick={() => set({ points: [...(p.points ?? []), newPoint(p)] })}>
        + Punto (x, y)
      </button>
    </Section>
  );
}

const DIRS: { id: string; label: string }[] = [
  { id: 'none', label: 'Solo opacidad' },
  { id: 'left', label: 'Desde la izquierda' },
  { id: 'right', label: 'Desde la derecha' },
  { id: 'up', label: 'Desde arriba' },
  { id: 'down', label: 'Desde abajo' },
];

function Animations() {
  const selection = useStore((s) => s.ui.selection);
  const objects = useStore((s) => s.project.objects);
  const time = useStore((s) => s.ui.time);
  const nodeExists = useStore((s) => (s.ui.selection ? true : false));
  const [duration, setDuration] = useState(1.5);
  const [sound, setSound] = useState<SoundId | ''>('');
  const [dir, setDir] = useState('left');
  const [dist, setDist] = useState(150);
  const [rotMode, setRotMode] = useState<'angle' | 'spin'>('angle');
  const [angle, setAngle] = useState(360);
  const [speed, setSpeed] = useState(90);

  const info = selection ? engine.runtime?.getNodeInfo(selection) ?? null : null;
  const enabled = !!selection && nodeExists && !!info;
  const start = Math.round(time * 100) / 100;

  const add = (type: ClipType, parameters: Record<string, number | string> = {}) => {
    if (!selection) return;
    actions.addClip({ targetId: selection, type, start, duration, parameters, sound: sound || null });
  };

  const reason = enabled ? undefined : 'Selecciona un objeto primero';
  const [colorParams, setColorParams] = useState<ClipParams>(() => defaultClipParams('colorChange'));

  return (
    <Section title="Animaciones">
      <p className="text-[11px] leading-snug text-slate-500">
        Cada botón crea un clip para la selección en el cabezal actual ({start.toFixed(2)} s).
      </p>
      <Field label="Duración (s)">
        <NumberInput className={`${input} w-20`} value={duration} min={0.1} step={0.1} onChange={setDuration} />
      </Field>
      <Field label="Sonido">
        <select className={`${input} w-36`} value={sound} onChange={(e) => setSound(e.target.value as SoundId | '')}>
          <option value="">Sin sonido</option>
          {SOUND_IDS.map((id) => (
            <option key={id} value={id}>{SOUND_LABEL[id]}</option>
          ))}
        </select>
      </Field>

      <div className="space-y-1.5">
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('draw')}>
          <PenTool size={14} /> Escribir / Dibujar
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('radar')}>
          <Radio size={14} /> Radar
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('glow')}>
          <Sparkles size={14} /> Brillar
        </button>

        <div className="space-y-1.5 rounded border border-bezel p-2">
          <button className={`${btn} w-full justify-start`} disabled={!enabled}
            title={reason ?? (colorParams.revertOnEnd === true ? 'Cambia el color y regresa al original al terminar' : 'Cambia el color de forma permanente (se mantiene tras el clip)')}
            onClick={() => selection && actions.addClip({ targetId: selection, type: 'colorChange', start, duration, parameters: colorParams, sound: sound || null })}>
            <Palette size={14} /> Cambiar Color
          </button>
          <ColorChangeFields compact value={colorParams} onChange={(patch) => setColorParams((current) => patchParams(current, patch))} />
        </div>

        <div className="space-y-1.5 rounded border border-bezel p-2">
          <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('appear', { direction: dir, distance: dist })}>
            <MoveRight size={14} /> Aparecer / Deslizar
          </button>
          <div className="flex gap-1.5">
            <select className={input} value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Dirección">
              {DIRS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <NumberInput className={`${input} w-16`} value={dist} min={0} step={10} onChange={setDist} ariaLabel="Distancia (px)" />
          </div>
        </div>

        <div className="space-y-1.5 rounded border border-bezel p-2">
          <button
            className={`${btn} w-full justify-start`}
            disabled={!enabled}
            title={reason}
            onClick={() => add('rotate', rotMode === 'angle' ? { mode: 'angle', angle } : { mode: 'spin', speed })}
          >
            <RotateCw size={14} /> Rotar
          </button>
          <div className="flex gap-1.5">
            <select className={input} value={rotMode} onChange={(e) => setRotMode(e.target.value as 'angle' | 'spin')} aria-label="Modo de giro">
              <option value="angle">Ángulo exacto (°)</option>
              <option value="spin">Giro sostenido (°/s)</option>
            </select>
            <NumberInput
              className={`${input} w-16`}
              value={rotMode === 'angle' ? angle : speed}
              step={rotMode === 'angle' ? 15 : 10}
              onChange={rotMode === 'angle' ? setAngle : setSpeed}
              ariaLabel={rotMode === 'angle' ? 'Ángulo' : 'Velocidad'}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Fórmula seleccionada (objeto raíz) o null. */
function useFormula() {
  const selection = useStore((s) => s.ui.selection);
  const objects = useStore((s) => s.project.objects);
  const object = objects.find((o) => o.id === selection?.split('.')[0]);
  return object && object.kind === 'formula' && !object.vector ? object : null;
}

function GlyphPanel() {
  const obj = useFormula();
  const termEdit = useStore((s) => s.ui.termEdit);
  const glyphSel = useStore((s) => s.ui.glyphSel);
  useStore((s) => s.ui.treeVersion);
  const [name, setName] = useState('');
  const group = useRef(Symbol());
  if (!obj) return null;

  const glyphs = engine.runtime?.getGlyphs(obj.id) ?? [];
  const editing = termEdit === obj.id;
  const sel = editing ? glyphSel : [];
  const first = sel.length ? obj.glyphStyles?.[sel[0]] ?? {} : {};
  const pick = (indices: number[]) => {
    if (!editing) actions.enterTermEdit(obj.id);
    actions.selectGlyphs(indices);
  };
  const edit = (patch: Parameters<typeof actions.setGlyphStyle>[2]) => actions.setGlyphStyle(obj.id, sel, patch, group.current);
  const renew = () => {
    group.current = Symbol();
  };

  return (
    <Section title="Términos de la ecuación">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">{glyphs.length} glifos · doble clic en el lienzo</span>
        <button className={editing ? btnPrimary : btn} aria-pressed={editing}
          onClick={() => (editing ? actions.exitTermEdit() : actions.enterTermEdit(obj.id))}
          title="Modo Edición de Términos (Esc para salir)">
          {editing ? 'Salir' : 'Editar términos'}
        </button>
      </div>

      <div className="flex flex-wrap gap-0.5" role="group" aria-label="Glifos de la ecuación">
        {glyphs.map((g) => {
          const on = sel.includes(g.index);
          return (
            <button key={g.index} data-glyph-chip={g.index} aria-pressed={on} title={`#${g.index} · ${g.glyphId}`}
              className={`h-5 min-w-5 rounded border px-1 font-mono text-[11px] ${on ? 'border-accent bg-accent-soft text-accent-light' : 'border-bezel bg-ink-700 text-slate-200 hover:bg-ink-600'}`}
              onClick={(e) => pick(e.shiftKey ? (on ? sel.filter((i) => i !== g.index) : [...sel, g.index]) : [g.index])}>
              {g.char || '·'}
            </button>
          );
        })}
      </div>

      <Field label="Glifos">
        <input key={formatGlyphList(sel)} className={`${input} w-28 font-mono`} defaultValue={formatGlyphList(sel)} placeholder="0-1,4"
          aria-label="Índices de glifos"
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => pick(parseGlyphList(e.target.value).filter((i) => i < glyphs.length))} />
      </Field>

      {sel.length > 0 && (
        <>
          <Field label="Color">
            <input type="color" className="h-6 w-9 cursor-pointer rounded border border-bezel bg-transparent"
              value={toHex(first.color) ?? '#f8fafc'} aria-label="Color de los glifos"
              onBlur={renew} onChange={(e) => edit({ color: e.target.value })} />
            {first.color !== undefined && (
              <button className="text-[11px] text-accent-light underline" onClick={() => edit({ color: undefined })}>original</button>
            )}
          </Field>
          <Field label="Escala local">
            <NumberInput className={`${input} w-20`} value={first.scale ?? 1} min={SCALE_MIN} max={SCALE_MAX} step={SCALE_STEP}
              onChange={(v) => edit({ scale: v === 1 ? undefined : v })} ariaLabel="Escala local" />
          </Field>
          <Field label="Opacidad (%)">
            <NumberInput className={`${input} w-20`} value={(first.opacity ?? 1) * 100} min={0} max={100} step={5}
              onChange={(v) => edit({ opacity: v >= 100 ? undefined : v / 100 })} ariaLabel="Opacidad de los glifos" />
          </Field>
          <button className={btn} onClick={() => edit({ color: undefined, scale: undefined, opacity: undefined })}>
            Restablecer glifos
          </button>
          <div className="flex gap-1.5">
            <input className={input} value={name} maxLength={60} placeholder="Nombre del término (ej. 4x)"
              aria-label="Nombre del término" onChange={(e) => setName(e.target.value)} />
            <button className={btn} disabled={!name.trim()}
              onClick={() => actions.saveTerm(obj.id, name, sel) && setName('')}>
              Guardar
            </button>
          </div>
        </>
      )}

      {!!obj.terms?.length && (
        <ul className="space-y-0.5" aria-label="Términos con nombre">
          {obj.terms.map((term) => (
            <li key={term.id} className="flex items-center gap-1 text-xs" data-term={term.id}>
              <button className="min-w-0 flex-1 truncate rounded px-1 text-left hover:bg-white/5" onClick={() => pick(term.glyphs)}
                title={`Seleccionar glifos ${formatGlyphList(term.glyphs)}`}>
                <span className="font-medium text-slate-100">{term.name}</span>{' '}
                <span className="font-mono text-[10px] text-slate-500">{formatGlyphList(term.glyphs)}</span>
              </button>
              <button className="p-0.5 text-slate-400 hover:text-rose-300" aria-label={`Eliminar término ${term.name}`}
                onClick={() => actions.removeTerm(obj.id, term.id)}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function EquationAnimations() {
  const obj = useFormula();
  const objects = useStore((s) => s.project.objects);
  const time = useStore((s) => s.ui.time);
  const termEdit = useStore((s) => s.ui.termEdit);
  const glyphSel = useStore((s) => s.ui.glyphSel);
  useStore((s) => s.ui.treeVersion);
  const [destGlyphs, setDestGlyphs] = useState<number[]>([]);
  const [copyMode, setCopyMode] = useState(true);
  const [connectors, setConnectors] = useState(false);
  const clips = useStore((s) => s.project.clips);
  const [duration, setDuration] = useState(1);
  const [scope, setScope] = useState('all');
  const [lag, setLag] = useState(0.1);
  const [factor, setFactor] = useState(1.3);
  const [color, setColor] = useState('#ffff00');
  const [glyphColor, setGlyphColor] = useState('#58C4DD');
  const [glyphRevert, setGlyphRevert] = useState(false);
  const [dest, setDest] = useState('');
  const [destTerm, setDestTerm] = useState('');
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [moveScale, setMoveScale] = useState(1);
  const [turn, setTurn] = useState(0);
  const [fade, setFade] = useState(100);
  const [keepSource, setKeepSource] = useState(false);
  const [tint, setTint] = useState(false);
  if (!obj) return null;

  const sel = termEdit === obj.id ? glyphSel : [];
  const start = Math.round(time * 100) / 100;
  const target = objects.find((o) => o.id === dest && o.id !== obj.id);
  const targetFormula = target && target.kind === 'formula' && !target.vector ? target : null;
  const term = scope.startsWith('term:') ? obj.terms?.find((entry) => entry.id === scope.slice(5)) : undefined;
  const chosen = scope === 'sel' && sel.length ? sel : term ? term.glyphs : null;
  const scopeParams = (): Record<string, number | string | boolean> => {
    if (scope === 'sel' && sel.length) return { glyphs: formatGlyphList(sel) };
    return term ? { term: term.id, glyphs: formatGlyphList(term.glyphs) } : {};
  };
  const add = (type: ClipType, parameters: Record<string, number | string | boolean> = {}) =>
    actions.addClip({ targetId: obj.id, type, start, duration, parameters, sound: null });
  const targetGlyphs = targetFormula ? engine.runtime?.getGlyphs(targetFormula.id) ?? [] : [];
  const pairsReady = !!targetFormula && sel.length > 0 && sel.length === destGlyphs.length;
  const charOf = (glyphs: { index: number; char: string }[], index: number) => glyphs.find((g) => g.index === index)?.char || '·';
  const sourceGlyphs = engine.runtime?.getGlyphs(obj.id) ?? [];
  const toggleDest = (index: number) =>
    setDestGlyphs((list) => (list.includes(index) ? list.filter((i) => i !== index) : [...list, index]));
  /** Glifo → glifo: sel[i] (origen, en orden) viaja a destGlyphs[i] (destino, en orden de marcado). */
  const glyphTransform = () => {
    if (!targetFormula || !pairsReady) return;
    actions.addClip({
      targetId: obj.id, type: 'transform', start, duration, sound: null,
      parameters: glyphTransformParams({
        sourceObjectId: obj.id, sourceGlyphIds: sel.map((i) => glyphIdOf(obj.id, i)),
        targetObjectId: targetFormula.id, targetGlyphIds: destGlyphs.map((j) => glyphIdOf(targetFormula.id, j)),
        keepSource: copyMode, revealConnectors: connectors,
      }),
    });
  };
  // Glifos de la ecuación destino que ningún clip dirigido ni de entrada (Write/FadeIn) cubre todavía.
  const remaining = (() => {
    if (!targetFormula) return [];
    const set = directedTargets(directedGlyphClips(clips)).get(targetFormula.id);
    if (!set?.size) return [];
    return targetGlyphs.map((g) => g.index).filter((i) => !set.has(i)
      && !clips.some((k) => (k.type === 'draw' || k.type === 'appear') && k.targetId === targetFormula.id
        && entranceScope(targetFormula, k.parameters, set, targetGlyphs.length)?.includes(i)));
  })();
  const selectRemaining = () => {
    if (!targetFormula) return;
    actions.enterTermEdit(targetFormula.id);
    actions.selectGlyphs(remaining);
    setScope('sel');
  };
  /** Brotar (Pop): un clip independiente por selección; encadena tras un Pop previo que cubra el cabezal. */
  const pop = () => {
    const parameters = scope === 'all' && sel.length ? { glyphs: formatGlyphList(sel) } : scopeParams();
    const busy = clips.filter((k) => k.targetId === obj.id && k.type === 'appear' && k.parameters.mode === 'pop'
      && k.start <= start + 1e-6 && k.start + k.duration > start + 1e-6);
    const at = busy.reduce((max, k) => Math.max(max, k.start + k.duration), start);
    actions.addClip({ targetId: obj.id, type: 'appear', start: Math.round(at * 100) / 100, duration, parameters: { ...parameters, mode: 'pop' }, sound: null });
  };
  const transform = (replace: boolean) => add('transform', target
    ? { ...scopeParams(), to: target.id, replace, ...(destTerm ? { toTerm: destTerm } : {}), ...(keepSource ? { keep: true } : {}) }
    : { ...scopeParams(), replace, dx, dy, scale: moveScale, rotation: turn, opacity: fade / 100, ...(tint ? { color } : {}) });

  return (
    <Section title="Ecuaciones (Manim)">
      <p className="text-[11px] leading-snug text-slate-500">
        Crean un clip en el cabezal ({start.toFixed(2)} s). El énfasis afecta solo al alcance elegido.
      </p>
      <Field label="Duración (s)">
        <NumberInput className={`${input} w-20`} value={duration} min={0.1} step={0.1} onChange={setDuration} />
      </Field>
      <Field label="Alcance">
        <select className={input} value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Alcance de la animación">
          <option value="all">Toda la ecuación</option>
          <option value="sel" disabled={!sel.length}>Selección actual ({sel.length})</option>
          {obj.terms?.map((entry) => <option key={entry.id} value={`term:${entry.id}`}>Término «{entry.name}»</option>)}
        </select>
      </Field>

      <div className="space-y-1.5 rounded border border-bezel p-2">
        <button className={`${btn} w-full justify-start`} onClick={() => add('draw', { ...scopeParams(), lagRatio: lag })}
          title="Con alcance «Selección» o «Término», solo aparecen esos glifos">
          <PenTool size={14} /> Write por glifo
        </button>
        <button className={`${btn} w-full justify-start`} onClick={() => add('appear', { ...scopeParams(), direction: 'up', distance: 40 })}
          title="FadeIn del alcance elegido (por ejemplo «+» o paréntesis de la ecuación destino)">
          <Sparkles size={14} /> FadeIn
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!chosen && !sel.length} onClick={pop}
          title={chosen || sel.length ? 'GrowFromCenter: el glifo seleccionado brota desde su centro (0 → 1.2 → 1)' : 'Selecciona glifos con los chips de «Términos de la ecuación»'}>
          <Maximize size={14} /> Brotar (Pop)
        </button>
        <Field label="lag_ratio">
          <NumberInput className={`${input} w-16`} value={lag} min={0} max={5} step={0.05} onChange={setLag} ariaLabel="lag_ratio" />
        </Field>
      </div>

      <div className="space-y-1.5 rounded border border-bezel p-2">
        <button className={`${btn} w-full justify-start`} onClick={() => add('indicate', { ...scopeParams(), scale: factor, color })}>
          <Sparkles size={14} /> Indicate
        </button>
        <div className="flex items-center gap-1.5">
          <button className={`${btn} flex-1 justify-start`}
            title={glyphRevert ? 'Tiñe los glifos elegidos y regresa a su color al terminar' : 'Cambio de color permanente de los glifos elegidos'}
            onClick={() => add('colorChange', {
              ...scopeParams(), fillEnabled: true, targetFillColor: glyphColor, strokeEnabled: false, ...(glyphRevert ? { revertOnEnd: true } : {}),
            })}>
            <Palette size={14} /> Cambiar Color
          </button>
          <input type="color" className="h-6 w-8 shrink-0 cursor-pointer rounded border border-bezel bg-transparent"
            aria-label="Nuevo color de los glifos" title="Nuevo color de los glifos" value={glyphColor} onChange={(e) => setGlyphColor(e.target.value)} />
        </div>
        <label className="flex items-center gap-1 text-[11px] text-slate-300" title="25 % entra al color, 50 % lo mantiene y 25 % regresa al color previo">
          <input type="checkbox" checked={glyphRevert} onChange={(e) => setGlyphRevert(e.target.checked)} />
          Regresar al terminar
        </label>
        <button className={`${btn} w-full justify-start`} onClick={() => add('circumscribe', { ...scopeParams(), color })}>
          <Radio size={14} /> Circumscribe
        </button>
        <button className={`${btn} w-full justify-start`} onClick={() => add('focus', { ...scopeParams(), color: '#888888', opacity: 0.2 })}>
          <Maximize size={14} /> FocusOn
        </button>
        <Field label="Escala">
          <NumberInput className={`${input} w-16`} value={factor} min={0.1} max={10} step={0.1} onChange={setFactor} ariaLabel="Escala del énfasis" />
        </Field>
        <Field label="Color">
          <input type="color" className="h-6 w-9 cursor-pointer rounded border border-bezel bg-transparent" value={color}
            onChange={(e) => setColor(e.target.value)} aria-label="Color del énfasis" />
        </Field>
      </div>

      <div className="space-y-1.5 rounded border border-bezel p-2">
        <Field label="Destino">
          <select className={input} value={dest} onChange={(e) => { setDest(e.target.value); setDestTerm(''); setDestGlyphs([]); }} aria-label="Objeto destino">
            <option value="">Estado (sin objeto)</option>
            {objects.filter((o) => o.id !== obj.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>
        {targetFormula?.terms?.length ? (
          <Field label="Término destino">
            <select className={input} value={destTerm} onChange={(e) => setDestTerm(e.target.value)} aria-label="Término destino">
              <option value="">Toda la ecuación</option>
              {targetFormula.terms.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </Field>
        ) : null}
        {!target && (
          <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-400">
            <label>Δx<NumberInput className={input} value={dx} step={10} onChange={setDx} ariaLabel="Desplazamiento X" /></label>
            <label>Δy<NumberInput className={input} value={dy} step={10} onChange={setDy} ariaLabel="Desplazamiento Y" /></label>
            <label>Escala<NumberInput className={input} value={moveScale} min={0.1} step={0.1} onChange={setMoveScale} ariaLabel="Escala destino" /></label>
            <label>Giro (°)<NumberInput className={input} value={turn} step={15} onChange={setTurn} ariaLabel="Giro destino" /></label>
            <label>Opacidad %<NumberInput className={input} value={fade} min={0} max={100} step={10} onChange={setFade} ariaLabel="Opacidad destino" /></label>
            <label className="flex items-end gap-1 pb-1"><input type="checkbox" checked={tint} onChange={(e) => setTint(e.target.checked)} /> Color</label>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-slate-300"
          title="La ecuación origen se queda fija y una copia viaja hacia el destino (Manim: origen.copy())">
          <input type="checkbox" checked={keepSource} disabled={!target} onChange={(e) => setKeepSource(e.target.checked)} />
          Mantener ecuación origen
        </label>
        <button className={`${btn} w-full justify-start`} onClick={() => transform(false)}>
          <MoveRight size={14} /> Transform
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!target} title={target ? undefined : 'Elige un objeto destino'} onClick={() => transform(true)}>
          <MoveRight size={14} /> ReplacementTransform
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!targetFormula || !!chosen}
          title={targetFormula ? chosen ? 'TransformMatchingTex usa la ecuación completa' : undefined : 'Elige otra ecuación como destino'}
          onClick={() => add('transformMatch', { to: targetFormula!.id, ...(keepSource ? { keep: true } : {}) })}>
          <RotateCw size={14} /> TransformMatchingTex
        </button>
      </div>

      <div className="space-y-1.5 rounded border border-bezel p-2" aria-label="Transformación dirigida de glifos">
        <div className="text-[11px] font-semibold text-slate-300">Glifo → glifo (TransformFromCopy)</div>
        <p className="text-[11px] leading-snug text-slate-500">
          1) Doble clic en esta ecuación y elige glifos origen ({sel.length}). 2) Elige el objeto Destino. 3) Marca los glifos destino
          en orden: el i-ésimo origen viaja al i-ésimo destino.
        </p>
        {targetFormula ? (
          <>
            <div className="flex flex-wrap gap-0.5" role="group" aria-label="Glifos de la ecuación destino">
              {targetGlyphs.map((g) => {
                const order = destGlyphs.indexOf(g.index);
                return (
                  <button key={g.index} data-dest-glyph={g.index} aria-pressed={order >= 0} title={`#${g.index} · ${g.glyphId}`}
                    className={`h-5 min-w-5 rounded border px-1 font-mono text-[11px] ${order >= 0 ? 'border-accent bg-accent-soft text-accent-light' : 'border-bezel bg-ink-700 text-slate-200 hover:bg-ink-600'}`}
                    onClick={() => toggleDest(g.index)}>
                    {g.char || '·'}{order >= 0 && <sup className="ml-0.5 text-[8px]">{order + 1}</sup>}
                  </button>
                );
              })}
            </div>
            {(sel.length > 0 || destGlyphs.length > 0) && (
              <div className="font-mono text-[10px] text-slate-400" data-glyph-pairs>
                {Array.from({ length: Math.max(sel.length, destGlyphs.length) }, (_, i) => (
                  <span key={i} className="mr-1.5 inline-block">
                    {i < sel.length ? charOf(sourceGlyphs, sel[i]) : '?'}→{i < destGlyphs.length ? charOf(targetGlyphs, destGlyphs[i]) : '?'}
                  </span>
                ))}
              </div>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-slate-300"
              title="Activo: una copia viaja y el origen queda en su sitio. Inactivo: el origen se mueve (ReplacementTransform)">
              <input type="checkbox" checked={copyMode} onChange={(e) => setCopyMode(e.target.checked)} />
              Mantener origen (copia)
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-300"
              title="Los operadores y paréntesis sin glifo dirigido brotan (escala 0.4→1 y fundido) en el último 40 % del clip que completa a sus vecinos">
              <input type="checkbox" checked={connectors} onChange={(e) => setConnectors(e.target.checked)} />
              Revelar conectores (·, +, =) al aterrizar
            </label>
            <button className={`${btn} w-full justify-start`} disabled={!pairsReady} onClick={glyphTransform}
              title={pairsReady ? undefined : `Origen (${sel.length}) y destino (${destGlyphs.length}) deben tener el mismo número de glifos`}>
              <MoveRight size={14} /> {copyMode ? 'TransformFromCopy' : 'ReplacementTransform (glifos)'}
            </button>
            {destGlyphs.length > 0 && (
              <button className="text-[11px] text-accent-light underline" onClick={() => setDestGlyphs([])}>limpiar destino</button>
            )}
            {remaining.length > 0 && (
              <button className={`${btn} w-full justify-start`} onClick={selectRemaining}
                title="Selecciona en la ecuación destino los glifos sin clip (p. ej. + o =) para aplicarles Write o FadeIn">
                Seleccionar restantes ({remaining.length})
              </button>
            )}
          </>
        ) : (
          <p className="text-[11px] text-slate-500">Elige una ecuación como Destino para marcar sus glifos.</p>
        )}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ escena / fondo

const BG_TEMPLATES: { id: SceneBackgroundType; label: string }[] = [
  { id: 'solid', label: 'Sólido' },
  { id: 'grid-dots', label: 'Cuadrícula' },
  { id: 'isometric-dots', label: 'Isométrico' },
];

/** Miniatura de cada plantilla (geometría real con una celda de 12 px). */
function BackgroundThumb({ type, bgColor, lineColor }: { type: SceneBackgroundType; bgColor: string; lineColor: string }) {
  const w = 56;
  const h = 32;
  const sample: SceneBackground = { type, bgColor, lineColor, opacity: 0.8, cellSize: 12, dotRadius: 1.3 };
  const { lines, dots } = sceneBackgroundGeometry(sample, w / 2, h / 2, 0, 0, w, h);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block rounded-sm" aria-hidden="true">
      <rect width={w} height={h} fill={bgColor} />
      <g opacity={sample.opacity}>
        <g stroke={lineColor} strokeWidth={0.6}>
          {lines.map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />)}
        </g>
        <g fill={lineColor}>{dots.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={sample.dotRadius} />)}</g>
      </g>
    </svg>
  );
}

/** Plantillas de fondo de escena: selector visual y parámetros de la retícula. */
function SceneBackgroundPanel() {
  const background = useStore((s) => s.project.background);
  const sceneBackground = useStore((s) => s.project.sceneBackground);
  const bg = resolveSceneBackground({ background, sceneBackground });
  const active = sceneBackground ? bg.type : null;
  const grid = bg.type !== 'solid';
  // Un arrastre (deslizador o selector de color) = una sola entrada de historial.
  const dragGroup = useRef<symbol>(Symbol('scene-bg'));
  const startGroup = () => { dragGroup.current = Symbol('scene-bg'); };
  const set = (patch: Parameters<typeof actions.setSceneBackground>[0]) => actions.setSceneBackground(patch, dragGroup.current);
  const range = (key: 'cellSize' | 'dotRadius' | 'opacity', step: number, label: string, format: (v: number) => string) => (
    <Field label={label}>
      <input type="range" className="w-full min-w-0 accent-accent" aria-label={label} disabled={!grid}
        min={SCENE_BG_LIMITS[key].min} max={SCENE_BG_LIMITS[key].max} step={step} value={bg[key]}
        onPointerDown={startGroup} onKeyDown={startGroup} onChange={(e) => set({ [key]: parseFloat(e.target.value) } as { [K in typeof key]?: number })} />
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{format(bg[key])}</span>
    </Field>
  );
  return (
    <Section title="Escena / Fondo">
      <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Plantilla de fondo">
        {BG_TEMPLATES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={active === t.id} title={t.label}
            className={`flex flex-col items-center gap-0.5 rounded border p-1 text-[10px] ${active === t.id ? 'border-accent text-slate-100' : 'border-bezel text-slate-400 hover:border-slate-500'}`}
            onClick={() => actions.setSceneBackgroundType(t.id)}>
            <BackgroundThumb type={t.id} bgColor={t.id === 'solid' ? bg.bgColor : (grid ? bg.bgColor : GRID_BG_COLOR)} lineColor={bg.lineColor} />
            {t.label}
          </button>
        ))}
      </div>
      <Field label="Color de fondo">
        <input type="color" className={colorInput} aria-label="Color de fondo" value={toHex(bg.bgColor) ?? '#000000'}
          onFocus={startGroup} onPointerDown={startGroup} onChange={(e) => set({ bgColor: e.target.value })} />
      </Field>
      <Field label="Color de retícula">
        <input type="color" className={colorInput} aria-label="Color de retícula" value={toHex(bg.lineColor) ?? '#7c878e'} disabled={!grid}
          onFocus={startGroup} onPointerDown={startGroup} onChange={(e) => set({ lineColor: e.target.value })} />
      </Field>
      {range('cellSize', 1, 'Celda (px)', (v) => String(Math.round(v)))}
      {range('dotRadius', 0.1, 'Nodo', (v) => v.toFixed(1))}
      {range('opacity', 0.01, 'Opacidad', (v) => `${Math.round(v * 100)}%`)}
    </Section>
  );
}

export function RightPanel() {
  const hasSelection = useStore((s) => !!s.ui.selection || s.ui.multiSelection.length > 0);
  return (
    <aside className="scroll-thin w-[248px] shrink-0 overflow-y-auto border-l border-bezel bg-ink-800">
      <Inspector />
      {!hasSelection && <SceneBackgroundPanel />}
      <PlaneInspector />
      <GlyphPanel />
      <Animations />
      <EquationAnimations />
    </aside>
  );
}
