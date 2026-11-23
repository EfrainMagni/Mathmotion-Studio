import { BACKGROUND_COLOR, STAGE_SIZES } from '../types';
import { actions, store } from '../store';
import { audio, engine } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Orden de preferencia: MP4 (H.264) si el navegador lo graba; si no, WebM. */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/** Duración por defecto de una escena sin clips ni voz. */
const STATIC_SECONDS = 3;

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export const QUALITY = {
  light: { video: 1_200_000, audio: 96_000, label: 'Ligera (~1,2 Mbps)' },
  standard: { video: 4_000_000, audio: 128_000, label: 'Estándar (~4 Mbps)' },
} as const;

interface Active {
  stop: (reason: 'manual' | 'complete') => void;
}
let active: Active | null = null;

export function isRecording() {
  return active !== null;
}

export function stopRecording() {
  active?.stop('manual');
}

const setRec = (patch: Partial<ReturnType<typeof store.getState>['ui']['recording']>) => {
  const cur = store.getState().ui.recording;
  store.setUi({ recording: { ...cur, ...patch } });
};

function fail(msg: string) {
  setRec({ phase: 'idle', message: null });
  actions.notify('error', msg);
}


function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, background: keyof typeof BACKGROUND_COLOR) {
  ctx.fillStyle = BACKGROUND_COLOR[background];
  ctx.fillRect(0, 0, W, H);
  if (background !== 'grid') return;
  // Misma cuadrícula que `.mm-grid`: líneas de 2 px cada 200 px y de 1 px cada 40 px.
  const lines = (step: number, width: number, alpha: number) => {
    ctx.fillStyle = `rgba(160,160,160,${alpha})`;
    for (let x = 0; x < W; x += step) ctx.fillRect(x, 0, width, H);
    for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, width);
  };
  lines(40, 1, 0.11);
  lines(200, 2, 0.27);
}

/**
 * Inicia la grabación directa del escenario. No usa la captura de pantalla: cada fotograma se dibuja
 * en un canvas oculto a la resolución lógica del escenario (1920×1080 o 1080×1920, sin interfaz) y ese
 * canvas se graba con `captureStream` + `MediaRecorder`, mezclando la pista de audio del proyecto.
 */
export function beginRecording() {
  if (active) return;
  const { ui } = store.getState();
  const mime = pickMime();
  if (!mime) return fail('Este navegador no admite ningún formato de grabación compatible (MediaRecorder).');
  if (!('captureStream' in HTMLCanvasElement.prototype)) {
    return fail('Este navegador no permite grabar un canvas (captureStream).');
  }
  const runtime = engine.runtime;
  const playback = engine.playback;
  if (!runtime || !playback) return fail('El escenario aún no está listo.');
  audio.ensure(); // dentro del gesto del usuario: desbloquea el audio
  void run(runtime, playback, mime, ui.recordQuality);
}

async function run(
  runtime: NonNullable<typeof engine.runtime>,
  playback: NonNullable<typeof engine.playback>,
  mime: string,
  quality: 'light' | 'standard',
) {
  const project = store.getState().project;
  const { w: W, h: H } = STAGE_SIZES[project.format];
  const isStatic = project.clips.length === 0 && !project.voice;
  const prevSpeed = playback.speed;
  const chunks: Blob[] = [];
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let finished = false;
  let startedRecording = false;
  let busy = false;
  let hasFrame = false;
  let raf = 0;
  let endTimer = 0;

  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const base = mk(); // fondo + capa 3D (se copia de forma síncrona)
  const frame = mk(); // último fotograma completo
  const out = mk(); // el que se captura
  out.setAttribute('aria-hidden', 'true');
  out.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(out);
  const bctx = base.getContext('2d')!;
  const fctx = frame.getContext('2d')!;
  const octx = out.getContext('2d')!;

  /** Dibuja el estado actual del runtime. Debe llamarse justo después de `renderAt` (por el WebGL). */
  const grab = () => {
    if (busy || finished) return;
    busy = true;
    let snap: ReturnType<typeof runtime.snapshotScene>;
    try {
      drawBackground(bctx, W, H, store.getState().project.background);
      snap = runtime.snapshotScene(W, H);
      for (const gl of snap.gl) bctx.drawImage(gl, 0, 0, W, H);
    } catch {
      busy = false;
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(new Blob([snap.svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.src = url;
    img
      .decode()
      .then(() => {
        fctx.drawImage(base, 0, 0);
        fctx.drawImage(img, 0, 0, W, H);
        octx.drawImage(frame, 0, 0);
        hasFrame = true;
      })
      .catch(() => {
        /* se conserva el fotograma anterior */
      })
      .finally(() => {
        URL.revokeObjectURL(url);
        busy = false;
      });
  };

  const cleanup = () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(endTimer);
    playback.onTick = null;
    playback.onComplete = null;
    playback.pause();
    playback.setSpeed(prevSpeed);
    stream?.getTracks().forEach((t) => t.stop());
    audio.releaseRecordingDestination();
    out.remove();
    active = null;
  };

  const finalize = () => {
    if (finished) return;
    finished = true;
    setRec({ phase: 'finishing', message: 'Guardando archivo…' });
    const finish = () => {
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      cleanup();
      if (!startedRecording || blob.size === 0) {
        fail('No se grabó ningún dato.');
        return;
      }
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `mathmotion-clase-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
      const prev = store.getState().ui.recording.lastFile;
      if (prev) URL.revokeObjectURL(prev.url);
      const urlObj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = urlObj;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setRec({ phase: 'idle', message: null, captureSize: null, lastFile: { url: urlObj, name, size: blob.size, mime: blob.type } });
      actions.notify('info', `Grabación lista: ${name}`);
    };
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = finish;
      try {
        recorder.stop();
      } catch {
        finish();
      }
    } else finish();
  };

  active = {
    stop: () => {
      if (finished) return;
      if (!startedRecording) {
        // aún en preparación: cancelar sin archivo
        finished = true;
        cleanup();
        setRec({ phase: 'idle', message: null, captureSize: null });
        return;
      }
      finalize();
    },
  };

  setRec({ phase: 'preparing', message: 'Preparando la grabación…', captureSize: { w: W, h: H } });

  // 1) Escena lista (capa 3D incluida) y primer fotograma limpio
  try {
    await runtime.whenReady();
  } catch {
    /* sin capa 3D: se graba igualmente la 2D */
  }
  if (finished) return;
  playback.restart();
  playback.setSpeed(1);
  grab();
  const t0 = performance.now();
  while (!hasFrame && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 16));
  if (finished) return;
  if (!hasFrame) {
    cleanup();
    return fail('No se pudo dibujar el escenario en el canvas de grabación.');
  }

  // 2) Canvas oculto → vídeo, más la mezcla de audio común
  try {
    stream = out.captureStream(60);
    const dest = audio.createRecordingDestination();
    const mixed = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const q = QUALITY[quality];
    recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: q.video, audioBitsPerSecond: q.audio });
  } catch (e) {
    cleanup();
    return fail(`No se pudo crear el grabador (${mime}): ${(e as Error).message}`);
  }
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onerror = () => active?.stop('manual');

  // Vuelca el último fotograma en cada refresco: el vídeo mantiene su ritmo aunque la escena sea estática.
  const pump = () => {
    octx.drawImage(frame, 0, 0);
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  // 3) Grabar: escena animada desde 0 s, o escena estática de STATIC_SECONDS
  recorder.start(1000);
  startedRecording = true;
  setRec({ phase: 'recording', message: 'Grabando…', captureSize: { w: W, h: H } });
  if (isStatic) {
    endTimer = window.setTimeout(() => active?.stop('complete'), STATIC_SECONDS * 1000);
    return;
  }
  playback.onTick = () => grab(); // justo después de dibujar cada fotograma
  playback.onComplete = () => {
    grab();
    // pequeña cola para que el último fotograma quede en el archivo
    endTimer = window.setTimeout(() => active?.stop('complete'), 700);
  };
  playback.play();
}
