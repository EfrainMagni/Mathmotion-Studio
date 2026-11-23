import { useRef, useState } from 'react';
import { audio } from '../engine';
import { parseProject, serializeProject } from '../engine/projectFiles';
import { activateProject } from '../engine/projectStorage';
import { Crosshair, Download, Loader2, Orbit, Square, Video } from 'lucide-react';
import { actions, defaultProject, store, useStore } from '../store';
import type { StageBackground, StageFormat } from '../types';
import { QUALITY, beginRecording, pickMime, stopRecording } from '../engine/recorder';

const FORMATS: { id: StageFormat; label: string }[] = [
  { id: '9:16', label: '9:16 · 1080×1920' },
  { id: '16:9', label: '16:9 · 1920×1080' },
];
const BGS: { id: StageBackground; label: string }[] = [
  { id: 'board', label: 'Pizarra' },
  { id: 'grid', label: 'Cuadrícula' },
  { id: 'light', label: 'Claro' },
];

const seg = (on: boolean) =>
  `px-2.5 py-1 text-xs font-medium transition-colors ${on ? 'bg-cyan-500 text-ink-950' : 'bg-ink-700 text-slate-200 hover:bg-ink-600'}`;

export function TopBar() {
  const format = useStore((s) => s.project.format);
  const background = useStore((s) => s.project.background);
  const cameraMode = useStore((s) => s.ui.cameraMode);
  const showGuides = useStore((s) => s.ui.showGuides);
  const quality = useStore((s) => s.ui.recordQuality);
  const rec = useStore((s) => s.ui.recording);
  const has3d = useStore((s) => s.project.objects.some((o) => o.kind === 'shape3d'));
  const busy = rec.phase !== 'idle';
  const [working, setWorking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function confirmReplacement(message: string) {
    const project = store.getState().project;
    return (!project.objects.length && !project.clips.length && !project.voice) || window.confirm(message);
  }

  async function openProject(file?: File) {
    if (!file) return;
    setWorking(true);
    try {
      const project = parseProject(await file.text());
      const buffer = project.voice ? await audio.decodeVoice(project.voice.source) : null;
      if (store.getState().ui.recording.phase !== 'idle') return;
      if (!confirmReplacement('¿Reemplazar el proyecto actual por el del archivo?')) return;
      activateProject(project, buffer);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      actions.notify('error', `No se pudo abrir el proyecto. ${detail}`);
    } finally {
      setWorking(false);
    }
  }

  async function saveProject() {
    setWorking(true);
    try {
      const text = await serializeProject(store.getState().project);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'proyecto.mathmotion';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      actions.notify('error', 'No se pudo guardar el archivo del proyecto.');
    } finally {
      setWorking(false);
    }
  }

  const supported = !!pickMime() && !!navigator.mediaDevices?.getDisplayMedia;

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 bg-ink-800 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-cyan-500 text-sm font-black text-ink-950">∫</div>
        <span className="text-sm font-semibold tracking-tight">MathMotion Studio</span>
      </div>

      <div className="flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Proyecto">
        <input
          ref={input}
          type="file"
          accept=".mathmotion,.json,application/json"
          aria-label="Archivo de proyecto"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void openProject(file);
          }}
        />
        <button className={seg(false)} disabled={busy || working} onClick={() => {
          if (confirmReplacement('¿Crear un proyecto nuevo y reemplazar el proyecto actual?')) {
            activateProject(defaultProject(), null);
          }
        }}>Nuevo proyecto</button>
        <button className={seg(false)} disabled={busy || working} onClick={() => input.current?.click()}>Abrir proyecto</button>
        <button className={seg(false)} disabled={busy || working} onClick={() => void saveProject()}>Guardar proyecto</button>
      </div>

      <div className="flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Formato">
        {FORMATS.map((f) => (
          <button key={f.id} className={seg(format === f.id)} disabled={busy} onClick={() => actions.setFormat(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Fondo">
        {BGS.map((b) => (
          <button key={b.id} className={seg(background === b.id)} disabled={busy} onClick={() => actions.setBackground(b.id)}>
            {b.label}
          </button>
        ))}
      </div>

      <button
        className={`inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs ${showGuides ? 'bg-ink-600' : 'bg-ink-700'} hover:bg-ink-600`}
        onClick={() => store.setUi({ showGuides: !showGuides })}
        aria-pressed={showGuides}
        title="Guías del lienzo (se ocultan al reproducir y grabar)"
      >
        <Crosshair size={14} /> Guías
      </button>

      <button
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs disabled:opacity-40 ${cameraMode ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200' : 'border-white/10 bg-ink-700 hover:bg-ink-600'}`}
        onClick={() => store.setUi({ cameraMode: !cameraMode })}
        disabled={!has3d || busy}
        aria-pressed={cameraMode}
        title={has3d ? 'Orbitar la cámara 3D con el ratón (desactiva la selección 2D)' : 'Inserta un objeto 3D para usar la cámara'}
      >
        <Orbit size={14} /> Modo cámara
      </button>

      <div className="ml-auto flex items-center gap-3">
        {rec.message && (
          <span className="max-w-[420px] truncate text-xs text-amber-200" title={rec.message}>
            {rec.phase !== 'recording' && <Loader2 size={12} className="mr-1 inline animate-spin" />}
            {rec.message}
            {rec.captureSize && ` · captura ${rec.captureSize.w}×${rec.captureSize.h}`}
          </span>
        )}
        {rec.lastFile && rec.phase === 'idle' && (
          <a
            className="inline-flex items-center gap-1 text-xs text-cyan-300 underline"
            href={rec.lastFile.url}
            download={rec.lastFile.name}
            title={`${rec.lastFile.name} · ${(rec.lastFile.size / 1e6).toFixed(1)} MB`}
          >
            <Download size={12} /> Descargar de nuevo
          </a>
        )}
        <select
          className="rounded-md border border-white/10 bg-ink-700 px-2 py-1 text-xs"
          value={quality}
          disabled={busy}
          onChange={(e) => store.setUi({ recordQuality: e.target.value as 'light' | 'standard' })}
          aria-label="Calidad de grabación"
        >
          {(Object.keys(QUALITY) as (keyof typeof QUALITY)[]).map((q) => (
            <option key={q} value={q}>
              {QUALITY[q].label}
            </option>
          ))}
        </select>
        {rec.phase === 'idle' ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-40"
            onClick={beginRecording}
            disabled={!supported || working}
            title={supported ? 'Abre una vista limpia y graba la clase con voz y efectos' : 'Este navegador no admite la grabación de pantalla'}
          >
            <Video size={14} /> Grabar video
          </button>
        ) : (
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-200 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-white"
            onClick={stopRecording}
          >
            <Square size={14} /> {rec.phase === 'recording' ? 'Detener' : 'Cancelar'}
          </button>
        )}
      </div>
    </header>
  );
}
