import { STAGE_SIZES } from '../types';
import { actions, store } from '../store';
import { audio, engine } from './index';
import { channelName, type EditorToStage, type StageToEditor } from './stageLink';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm',
];

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export const QUALITY = {
  light: { video: 1_200_000, audio: 96_000, label: 'Ligera (~1,2 Mbps)' },
  standard: { video: 4_000_000, audio: 128_000, label: 'Estándar (~4 Mbps)' },
} as const;

interface Active {
  stop: (reason: 'manual' | 'complete' | 'capture-ended' | 'window-closed') => void;
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

/**
 * Inicia la grabación. DEBE llamarse directamente desde el manejador de clic:
 * `window.open` y `getDisplayMedia` se invocan de forma síncrona dentro del gesto del usuario.
 */
export function beginRecording() {
  if (active) return;
  const { project, ui } = store.getState();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return fail('Este navegador no admite captura de pantalla (getDisplayMedia).');
  }
  const mime = pickMime();
  if (!mime) return fail('Este navegador no admite ningún formato de grabación compatible (MediaRecorder).');
  if (!engine.playback) return fail('El escenario aún no está listo.');
  if (project.clips.length === 0 && !project.voice) {
    return fail('No hay animaciones ni voz para grabar. Añade al menos un clip.');
  }

  const sessionId = Math.random().toString(36).slice(2, 10);
  const url = new URL(window.location.href);
  url.search = `?stage=${sessionId}`;
  url.hash = '';
  const size = STAGE_SIZES[project.format];
  const portrait = size.h > size.w;
  const win = window.open(
    url.toString(),
    'mathmotion-stage',
    `popup=yes,width=${portrait ? 450 : 960},height=${portrait ? 800 : 540}`,
  );
  if (!win) return fail('El navegador bloqueó la ventana de grabación. Permite las ventanas emergentes e inténtalo de nuevo.');

  audio.ensure(); // dentro del gesto: desbloquea el audio
  setRec({
    phase: 'picker',
    message: 'En el selector del navegador elige la pestaña «MathMotion · vista de grabación».',
    captureSize: null,
  });

  let displayPromise: Promise<MediaStream>;
  try {
    displayPromise = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, displaySurface: 'browser' } as any,
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      preferCurrentTab: false,
    } as any);
  } catch (e) {
    win.close();
    return fail(`No se pudo iniciar la captura: ${(e as Error).message}`);
  }
  void run(displayPromise, win, sessionId, mime, ui.recordQuality);
}

async function run(
  displayPromise: Promise<MediaStream>,
  win: Window,
  sessionId: string,
  mime: string,
  quality: 'light' | 'standard',
) {
  const playback = engine.playback!;
  const channel = new BroadcastChannel(channelName(sessionId));
  let display: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let finished = false;
  let pollTimer = 0;
  const prevSpeed = playback.speed;
  const chunks: Blob[] = [];
  let startedRecording = false;

  const cleanup = () => {
    window.clearInterval(pollTimer);
    playback.onTick = null;
    playback.onComplete = null;
    playback.pause();
    playback.setSpeed(prevSpeed);
    display?.getTracks().forEach((t) => t.stop()); // libera las pistas de captura
    audio.releaseRecordingDestination();
    channel.close();
    try {
      win.close();
    } catch {
      /* ya cerrada */
    }
    active = null;
  };

  const finalize = (reason: string) => {
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
      setRec({ phase: 'idle', message: null, lastFile: { url: urlObj, name, size: blob.size, mime: blob.type } });
      actions.notify(
        'info',
        reason === 'capture-ended'
          ? `La captura se cerró antes de terminar; se descargó lo grabado hasta ese momento (${name}).`
          : reason === 'window-closed'
            ? `Se cerró la vista de grabación; se descargó lo grabado hasta ese momento (${name}).`
            : `Grabación lista: ${name}`,
      );
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
    stop: (reason) => {
      if (!startedRecording) {
        // aún en preparación: cancelar sin archivo
        if (finished) return;
        finished = true;
        cleanup();
        setRec({ phase: 'idle', message: null });
        return;
      }
      finalize(reason);
    },
  };

  // 1) Permiso y selección de la fuente
  try {
    display = await displayPromise;
  } catch (e) {
    cleanup();
    const err = e as DOMException;
    if (err.name === 'NotAllowedError') {
      fail('Permiso denegado o selección cancelada. Pulsa «Grabar video» y elige la pestaña de la vista de grabación.');
    } else if (err.name === 'NotFoundError') {
      fail('No hay ninguna fuente de captura disponible.');
    } else if (err.name === 'NotSupportedError') {
      fail('Este navegador no admite la captura solicitada.');
    } else fail(`No se pudo iniciar la captura: ${err.message || err.name}`);
    return;
  }
  if (finished) {
    display.getTracks().forEach((t) => t.stop());
    return;
  }

  const vTrack = display.getVideoTracks()[0];
  if (!vTrack) {
    cleanup();
    return fail('La captura no incluye pista de video.');
  }
  const settings: any = vTrack.getSettings();
  if (settings.displaySurface && settings.displaySurface !== 'browser') {
    cleanup();
    return fail(
      'Elegiste una ventana o pantalla completa, y saldría la interfaz del editor. Vuelve a grabar y elige la pestaña «MathMotion · vista de grabación».',
    );
  }
  // Algunos navegadores exponen el título de la pestaña como etiqueta; si lo hacen y no es la vista limpia, se aborta.
  const label = vTrack.label || '';
  if (label && !/^web-contents-media-stream:|^screen:|^window:/i.test(label) && !/vista de grabaci/i.test(label)) {
    cleanup();
    return fail('La pestaña elegida no es «MathMotion · vista de grabación». Vuelve a grabar y selecciónala para no capturar el editor.');
  }
  // Cierre de la captura desde el botón «Dejar de compartir» del navegador
  vTrack.addEventListener('ended', () => active?.stop('capture-ended'));
  pollTimer = window.setInterval(() => {
    if (win.closed) active?.stop('window-closed');
  }, 500);

  setRec({ phase: 'preparing', message: 'Comprobando que la vista de grabación esté lista…' });

  // 2) La vista de grabación debe confirmar que aplicó el proyecto (incluida la capa 3D)
  const token = Math.random().toString(36).slice(2);
  const project = store.getState().project;
  const ready = await new Promise<boolean>((resolve) => {
    let done = false;
    const timer = window.setInterval(() => channel.postMessage({ type: 'project', token, project } satisfies EditorToStage), 400);
    const timeout = window.setTimeout(() => {
      finish(false);
    }, 10_000);
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      channel.removeEventListener('message', onMsg);
      resolve(v);
    };
    const onMsg = (e: MessageEvent<StageToEditor>) => {
      if (e.data.type === 'applied' && e.data.token === token) finish(true);
      if (e.data.type === 'hello') channel.postMessage({ type: 'project', token, project } satisfies EditorToStage);
    };
    channel.addEventListener('message', onMsg);
    channel.postMessage({ type: 'project', token, project } satisfies EditorToStage);
  });
  if (finished) return;
  if (!ready) {
    cleanup();
    return fail('La vista de grabación no respondió a tiempo. Ciérrala e inténtalo de nuevo.');
  }

  // 3) Audio común + video de la pestaña elegida
  const dest = audio.createRecordingDestination();
  const mixed = new MediaStream([vTrack, ...dest.stream.getAudioTracks()]);
  const q = QUALITY[quality];
  try {
    recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: q.video, audioBitsPerSecond: q.audio });
  } catch (e) {
    cleanup();
    return fail(`No se pudo crear el grabador (${mime}): ${(e as Error).message}`);
  }
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onerror = () => active?.stop('manual');

  // 4) Reproducir desde 0 s a velocidad 1×
  playback.restart();
  playback.setSpeed(1);
  channel.postMessage({ type: 'time', t: 0 } satisfies EditorToStage);
  await new Promise((r) => setTimeout(r, 400)); // deja que la vista dibuje el primer fotograma
  if (finished) return;
  playback.onTick = (t) => channel.postMessage({ type: 'time', t } satisfies EditorToStage);
  playback.onComplete = () => {
    // pequeña cola para que el último fotograma quede en el archivo
    window.setTimeout(() => active?.stop('complete'), 700);
  };
  recorder.start(1000);
  startedRecording = true;
  const s: any = vTrack.getSettings();
  setRec({
    phase: 'recording',
    message: 'Grabando…',
    captureSize: s.width && s.height ? { w: s.width, h: s.height } : null,
  });
  playback.play();
}
