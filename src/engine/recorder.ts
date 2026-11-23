import { BACKGROUND_COLOR, STAGE_SIZES, sceneDuration } from '../types';
import { actions, store } from '../store';
import { audio, engine } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Orden de preferencia: WebM (VP9/VP8) primero, porque en Chrome/Edge sobre Windows siempre genera una pista
 * de vídeo válida; MP4 (H.264) solo como último recurso (p. ej. Safari).
 */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

/** Fotogramas por segundo de la grabación. */
const FPS = 30;

/** Duración mínima de cualquier grabación (también la de una escena estática). */
const MIN_SECONDS = 3;

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
  const prevSpeed = playback.speed;
  const chunks: Blob[] = [];
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let finished = false;
  let startedRecording = false;
  let busy = false;
  let hasFrame = false;
  let tickTimer = 0;
  let endTimer = 0;
  const totalDuration = Math.max(sceneDuration(project), MIN_SECONDS);

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
  const paintOut = () => {
    // Fondo sólido en cada fotograma: la pista de vídeo nunca queda vacía ni transparente.
    drawBackground(octx, W, H, store.getState().project.background);
    octx.drawImage(frame, 0, 0);
  };
  drawBackground(fctx, W, H, project.background);

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
    const toImage = async (svg: string) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      return img;
    };
    (async () => {
      let img: HTMLImageElement;
      try {
        img = await toImage(snap.svg);
      } catch {
        // Respaldo: sin filtros, imágenes ni foreignObject, para que al menos las formas vectoriales se vean.
        img = await toImage(runtime.snapshotScene(W, H, true).svg);
      }
      fctx.drawImage(base, 0, 0);
      fctx.drawImage(img, 0, 0, W, H);
      hasFrame = true;
    })()
      .catch(() => {
        // Si todo falla se conserva el fondo (más la capa 3D) en lugar de un fotograma vacío.
        fctx.drawImage(base, 0, 0);
        hasFrame = true;
      })
      .finally(() => {
        busy = false;
      });
  };

  const cleanup = () => {
    window.clearInterval(tickTimer);
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
    stream = out.captureStream(FPS);
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

  // Bucle de renderizado a 30 fps (temporizador, no rAF: sigue vivo con la pestaña en segundo plano).
  // Cada tick pinta fondo + último fotograma y pide explícitamente un fotograma a la pista de vídeo.
  const videoTrack = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const pump = () => {
    if (finished) return;
    paintOut();
    if (recorder?.state === 'recording') videoTrack?.requestFrame?.();
  };
  pump();

  // 3) Grabar la duración real de la línea de tiempo (máx. de clips, voz y MIN_SECONDS), en tiempo real
  recorder.start(500);
  startedRecording = true;
  setRec({ phase: 'recording', message: 'Grabando…', captureSize: { w: W, h: H } });
  const startedAt = performance.now();
  tickTimer = window.setInterval(() => {
    pump();
    if (performance.now() - startedAt >= totalDuration * 1000 + 300) active?.stop('complete');
  }, 1000 / FPS);
  playback.onTick = () => grab(); // justo después de dibujar cada fotograma
  playback.onComplete = () => grab(); // la escena se queda en su último estado hasta totalDuration
  playback.play();
}
