import { useState } from 'react';
import { Orbit, PenTool, Radio, RotateCw, Sparkles, MoveRight, Maximize } from 'lucide-react';
import { actions, store, useStore } from '../store';
import { SOUND_IDS, SOUND_LABEL, STAGE_SIZES, is2D, type ClipType, type SoundId } from '../types';
import { engine } from '../engine';
import { Field, NumberInput, Section, btn, input } from './ui';

function toHex(css: string | undefined): string | null {
  if (!css) return null;
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase();
  const m = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  const m3 = css.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return null;
}

function PaintRow({
  label,
  value,
  fallbackHex,
  onColor,
  onNone,
  onReset,
  hasOverride,
  noneLabel,
}: {
  label: string;
  value: string | undefined;
  fallbackHex: string;
  onColor: (hex: string) => void;
  onNone: (none: boolean) => void;
  onReset: () => void;
  hasOverride: boolean;
  noneLabel: string;
}) {
  const isNone = value === 'none';
  const isPaintServer = !!value && value.startsWith('url(');
  const hex = toHex(value) ?? fallbackHex;
  return (
    <Field label={label}>
      <input
        type="color"
        value={hex}
        disabled={isNone}
        title={isPaintServer ? 'Degradado o patrón: elegir un color lo sustituye' : undefined}
        onChange={(e) => onColor(e.target.value)}
        className="h-6 w-9 cursor-pointer rounded border border-white/10 bg-transparent disabled:opacity-30"
        aria-label={label}
      />
      <label className="flex items-center gap-1 text-[11px] text-slate-400">
        <input type="checkbox" checked={isNone} onChange={(e) => onNone(e.target.checked)} /> {noneLabel}
      </label>
      {hasOverride && (
        <button className="text-[11px] text-cyan-300 underline" onClick={onReset} title="Volver al valor original">
          original
        </button>
      )}
    </Field>
  );
}

function Inspector() {
  const selection = useStore((s) => s.ui.selection);
  const project = useStore((s) => s.project);
  useStore((s) => s.ui.treeVersion);

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
  const is3d = info.kind === 'shape3d';
  const style = project.styles[selection] ?? {};
  const paint = is3d ? null : engine.runtime?.getPaint(selection) ?? null;
  const fill = style.fill ?? paint?.fill;
  const stroke = style.stroke ?? paint?.stroke;
  const strokeWidth = style.strokeWidth ?? paint?.strokeWidth ?? 0;
  const scale = info.isRoot ? obj.scale : style.scale ?? 1;
  const defaultFill = is3d ? '#38bdf8' : '#ffffff';

  const setScale = (v: number) => (info.isRoot ? actions.updateObject(obj.id, { scale: v }) : actions.setStyle(selection, { scale: v }));

  return (
    <Section title="Inspector">
      <div className="rounded bg-ink-900 p-2 text-xs">
        <div className="truncate font-semibold text-slate-100" title={info.name}>{info.name}</div>
        <div className="font-mono text-[10px] text-slate-500">
          {selection} · {is3d ? obj.kind === 'shape3d' && obj.shape : info.tag}
        </div>
      </div>

      {(is3d || paint) ? (
        <>
          <PaintRow
            label={is3d ? 'Superficie' : 'Relleno'}
            value={fill}
            fallbackHex={defaultFill}
            hasOverride={style.fill !== undefined}
            noneLabel="ninguno"
            onColor={(hex) => actions.setStyle(selection, { fill: hex })}
            onNone={(n) => actions.setStyle(selection, { fill: n ? 'none' : undefined })}
            onReset={() => actions.setStyle(selection, { fill: undefined })}
          />
          <PaintRow
            label={is3d ? 'Líneas' : 'Trazo'}
            value={stroke}
            fallbackHex="#ffffff"
            hasOverride={style.stroke !== undefined}
            noneLabel="ninguno"
            onColor={(hex) => actions.setStyle(selection, { stroke: hex, ...(strokeWidth <= 0 && !is3d ? { strokeWidth: 3 } : {}) })}
            onNone={(n) => actions.setStyle(selection, { stroke: n ? 'none' : undefined })}
            onReset={() => actions.setStyle(selection, { stroke: undefined, strokeWidth: undefined })}
          />
          <Field label="Grosor">
            <NumberInput
              className={`${input} w-20`}
              value={strokeWidth}
              min={0}
              step={0.5}
              disabled={is3d}
              onChange={(v) => actions.setStyle(selection, { strokeWidth: v })}
            />
          </Field>
        </>
      ) : (
        <p className="text-[11px] text-slate-500">Este elemento no tiene geometría con relleno ni trazo.</p>
      )}

      <Field label="Escala">
        <NumberInput className={`${input} w-20`} value={scale} min={0.01} max={20} step={0.05} onChange={setScale} />
      </Field>

      {info.isRoot && (
        <Field label={is3d ? 'Giro base (Y°)' : 'Rotación (°)'}>
          <NumberInput className={`${input} w-20`} value={obj.rotation} step={5} onChange={(v) => actions.updateObject(obj.id, { rotation: v })} />
        </Field>
      )}

      {info.isRoot && is2D(obj) && (
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

      {!info.isRoot && (
        <button
          className={btn}
          onClick={() => actions.setStyle(selection, { fill: undefined, stroke: undefined, strokeWidth: undefined, scale: undefined, tx: undefined, ty: undefined })}
        >
          Restablecer estilo y posición
        </button>
      )}
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
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('y');
  const [orbitAngle, setOrbitAngle] = useState(180);

  const info = selection ? engine.runtime?.getNodeInfo(selection) ?? null : null;
  const is3d = info?.kind === 'shape3d' && objects.some((o) => o.id === selection);
  const enabled = !!selection && nodeExists && !!info;
  const start = Math.round(time * 100) / 100;

  const add = (type: ClipType, parameters: Record<string, number | string> = {}) => {
    if (!selection) return;
    actions.addClip({ targetId: selection, type, start, duration, parameters, sound: sound || null });
  };

  const reason = enabled ? undefined : 'Selecciona un objeto primero';

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

      <div className="space-y-2">
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('draw')}>
          <PenTool size={14} /> Escribir / Dibujar
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('radar')}>
          <Radio size={14} /> Radar
        </button>
        <button className={`${btn} w-full justify-start`} disabled={!enabled} title={reason} onClick={() => add('glow')}>
          <Sparkles size={14} /> Brillar
        </button>

        <div className="space-y-1.5 rounded border border-white/5 p-2">
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

        <div className="space-y-1.5 rounded border border-white/5 p-2">
          <button
            className={`${btn} w-full justify-start`}
            disabled={!enabled}
            title={reason}
            onClick={() => add('rotate', rotMode === 'angle' ? { mode: 'angle', angle, axis } : { mode: 'spin', speed, axis })}
          >
            <RotateCw size={14} /> {is3d ? 'Rotar objeto' : 'Rotar'}
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
          {is3d && (
            <Field label="Eje">
              <select className={`${input} w-20`} value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')}>
                <option value="y">Y</option>
                <option value="x">X</option>
                <option value="z">Z</option>
              </select>
            </Field>
          )}
        </div>

        <div className="space-y-1.5 rounded border border-white/5 p-2">
          <button
            className={`${btn} w-full justify-start`}
            disabled={!enabled || !is3d}
            title={!is3d ? 'Selecciona un objeto 3D para orbitar la cámara' : undefined}
            onClick={() => add('orbit', { angle: orbitAngle })}
          >
            <Orbit size={14} /> Orbitar cámara
          </button>
          <Field label="Ángulo (°)">
            <NumberInput className={`${input} w-20`} value={orbitAngle} step={15} onChange={setOrbitAngle} />
          </Field>
        </div>
      </div>
    </Section>
  );
}

export function RightPanel() {
  return (
    <aside className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-l border-white/10 bg-ink-800">
      <Inspector />
      <Animations />
    </aside>
  );
}
