import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  SCENE_GRID_LINE_WIDTH, STAGE_SIZES, resolveSceneBackground, sceneBackgroundGeometry, sceneDuration, type Project,
} from '../types';
import { actions, store } from '../store';
import { audio, engine } from './index';
import { embeddedFontCss, loadFonts, usedFonts } from './fonts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Respaldo con `MediaRecorder` (navegadores sin `VideoEncoder`). Orden de preferencia: WebM (VP9/VP8) primero, porque
 * en Chrome/Edge sobre Windows siempre genera una pista de vídeo válida; MP4 (H.264) solo como último recurso.
 * La vía principal es MP4 (H.264) con `VideoEncoder` + `mp4-muxer`, que escribe la duración exacta en el archivo.
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

// ------------------------------------------------------------------ MP4 directo (WebCodecs + mp4-muxer)

/** `true` si el navegador ofrece WebCodecs para vídeo (la codificación H.264 concreta se comprueba al crear el sumidero). */
export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

interface Mp4Sink {
  /** Codifica el canvas como fotograma de la línea de tiempo `elapsedMs` (descarta duplicados y satura la cola). */
  addFrame(canvas: HTMLCanvasElement, elapsedMs: number, force?: boolean): void;
  /** Vacía los codificadores, cierra el contenedor y devuelve el `.mp4` con la duración exacta. */
  finish(totalMs: number, canvas: HTMLCanvasElement): Promise<Blob>;
  /** Libera codificadores y nodos de audio sin producir archivo. Es idempotente. */
  dispose(): void;
  error(): Error | null;
}

const TAP_PROCESSOR = `class MMTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const n = ch[0].length, out = new Float32Array(n * 2);
      out.set(ch[0], 0); out.set(ch[ch.length > 1 ? 1 : 0], n);
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('mm-tap', MMTap);`;
const tapModules = new WeakMap<BaseAudioContext, Promise<void>>();

async function createMp4Sink(W: number, H: number, quality: 'light' | 'standard', withAudio: boolean): Promise<Mp4Sink | null> {
  if (!hasWebCodecs()) return null;
  const q = QUALITY[quality];

  let videoCfg: VideoEncoderConfig | null = null;
  // H.264 High/Main nivel 4.0 y Baseline 4.2: cubren 1920×1080 y 1080×1920 a 30 fps.
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42002a']) {
    const cfg: VideoEncoderConfig = { codec, width: W, height: H, bitrate: q.video, framerate: FPS, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => null))?.supported) {
      videoCfg = cfg;
      break;
    }
  }
  if (!videoCfg) return null;

  let audioCfg: AudioEncoderConfig | null = null;
  let audioCodec: 'aac' | 'opus' = 'aac';
  let ctx: AudioContext | null = null;
  if (withAudio) {
    // Sin AudioEncoder/AudioWorklet se prefiere el respaldo de MediaRecorder antes que perder la voz.
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || typeof AudioWorkletNode === 'undefined') return null;
    ctx = audio.ensure();
    for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']] as const) {
      const cfg: AudioEncoderConfig = { codec, sampleRate: ctx.sampleRate, numberOfChannels: 2, bitrate: q.audio };
      if ((await AudioEncoder.isConfigSupported(cfg).catch(() => null))?.supported) {
        audioCfg = cfg;
        audioCodec = muxCodec;
        break;
      }
    }
    if (!audioCfg) return null;
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory', // `moov` al principio: duración y metadatos exactos
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    ...(audioCfg ? { audio: { codec: audioCodec, numberOfChannels: 2, sampleRate: audioCfg.sampleRate } } : {}),
  });

  let failure: Error | null = null;
  const onError = (e: Error) => {
    failure ??= e;
  };
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: onError });
  venc.configure(videoCfg);

  let aenc: AudioEncoder | null = null;
  let tap: AudioWorkletNode | null = null;
  let mute: GainNode | null = null;
  const teardownAudio = () => {
    try {
      if (tap) audio.master.disconnect(tap);
      tap?.disconnect();
      mute?.disconnect();
    } catch {
      /* ya desconectado */
    }
    if (tap) tap.port.onmessage = null;
    tap = null;
    mute = null;
  };
  if (audioCfg && ctx) {
    try {
      let ready = tapModules.get(ctx);
      if (!ready) {
        const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }));
        ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
        tapModules.set(ctx, ready);
      }
      await ready;
    } catch {
      tapModules.delete(ctx);
      venc.close();
      return null;
    }
    const encoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: onError });
    encoder.configure(audioCfg);
    aenc = encoder;
    const sampleRate = audioCfg.sampleRate;
    tap = new AudioWorkletNode(ctx, 'mm-tap', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
    });
    mute = ctx.createGain();
    mute.gain.value = 0; // el nodo debe llegar al destino para procesarse, pero no debe sonar
    let samples = 0;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (encoder.state !== 'configured') return;
      const frames = e.data.length / 2;
      const data = new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: frames, numberOfChannels: 2,
        timestamp: Math.round((samples / sampleRate) * 1e6), data: new Float32Array(e.data),
      });
      samples += frames;
      encoder.encode(data);
      data.close();
    };
    audio.master.connect(tap);
    tap.connect(mute).connect(ctx.destination);
  }

  let last = -1;
  let disposed = false;
  const addFrame = (canvas: HTMLCanvasElement, elapsedMs: number, force = false) => {
    if (disposed || venc.state !== 'configured') return;
    const index = Math.max(0, Math.floor((elapsedMs * FPS) / 1000));
    if (index <= last && !force) return;
    if (venc.encodeQueueSize > 12 && !force) return; // codificador saturado: se descarta el fotograma
    const at = force ? Math.max(index, last + 1) : index;
    const frame = new VideoFrame(canvas, { timestamp: Math.round((at * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(frame, { keyFrame: last < 0 || at % (FPS * 2) === 0 });
    frame.close();
    last = at;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    teardownAudio();
    if (venc.state !== 'closed') venc.close();
    if (aenc && aenc.state !== 'closed') aenc.close();
  };

  return {
    addFrame,
    error: () => failure,
    dispose,
    async finish(totalMs, canvas) {
      addFrame(canvas, totalMs, true); // el último fotograma fija la duración exacta
      teardownAudio();
      await venc.flush();
      await aenc?.flush();
      if (failure) throw failure;
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      dispose();
      return blob;
    },
  };
}

const setRec = (patch: Partial<ReturnType<typeof store.getState>['ui']['recording']>) => {
  const cur = store.getState().ui.recording;
  store.setUi({ recording: { ...cur, ...patch } });
};

function fail(msg: string) {
  setRec({ phase: 'idle', message: null });
  actions.notify('error', msg);
}


type BackgroundSource = Pick<Project, 'background' | 'sceneBackground'>;

/** Fondo clásico (`background: 'grid'` sin plantilla): misma cuadrícula que `.mm-grid`. */
function drawLegacyGrid(ctx: CanvasRenderingContext2D, W: number, H: number) {
  // Líneas de 2 px cada 200 px y de 1 px cada 40 px.
  const lines = (step: number, width: number, alpha: number) => {
    ctx.fillStyle = `rgba(160,160,160,${alpha})`;
    for (let x = 0; x < W; x += step) ctx.fillRect(x, 0, width, H);
    for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, width);
  };
  lines(40, 1, 0.11);
  lines(200, 2, 0.27);
}

/**
 * Pinta la plantilla de fondo a resolución completa, con la misma geometría que el `<pattern>` del lienzo
 * (nodo en el centro del escenario). Líneas y nodos se dibujan opacos en una capa aparte y se componen con
 * `opacity`, igual que el grupo SVG, para que los cruces no se oscurezcan dos veces.
 */
function paintBackground(ctx: CanvasRenderingContext2D, W: number, H: number, source: BackgroundSource) {
  const bg = resolveSceneBackground(source);
  ctx.fillStyle = bg.bgColor;
  ctx.fillRect(0, 0, W, H);
  if (!source.sceneBackground) {
    if (source.background === 'grid') drawLegacyGrid(ctx, W, H);
    return;
  }
  if (bg.type === 'solid') return;
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  const lctx = layer.getContext('2d')!;
  const { lines, dots } = sceneBackgroundGeometry(bg, W / 2, H / 2, 0, 0, W, H);
  lctx.strokeStyle = bg.lineColor;
  lctx.lineWidth = SCENE_GRID_LINE_WIDTH;
  lctx.lineCap = 'butt';
  lctx.beginPath();
  for (const [x1, y1, x2, y2] of lines) {
    lctx.moveTo(x1, y1);
    lctx.lineTo(x2, y2);
  }
  lctx.stroke();
  if (bg.dotRadius > 0) {
    lctx.fillStyle = bg.lineColor;
    lctx.beginPath();
    for (const [x, y] of dots) {
      lctx.moveTo(x + bg.dotRadius, y);
      lctx.arc(x, y, bg.dotRadius, 0, Math.PI * 2);
    }
    lctx.fill();
  }
  ctx.save();
  ctx.globalAlpha = bg.opacity;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** Caché del fondo pintado: se redibuja solo si cambian la plantilla o el tamaño (se usa en cada fotograma). */
let backgroundCache: { key: string; canvas: HTMLCanvasElement } | null = null;

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, source: BackgroundSource) {
  const key = JSON.stringify([W, H, source.background, source.sceneBackground ?? null]);
  if (!backgroundCache || backgroundCache.key !== key) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    paintBackground(canvas.getContext('2d')!, W, H, source);
    backgroundCache = { key, canvas };
  }
  ctx.drawImage(backgroundCache.canvas, 0, 0);
}

/**
 * Inicia la grabación directa del escenario. No usa la captura de pantalla: cada fotograma se dibuja
 * en un canvas oculto a la resolución lógica del escenario (1920×1080 o 1080×1920, sin interfaz) y ese
 * canvas se codifica directamente a MP4 (H.264 + AAC) con `VideoEncoder`/`AudioEncoder` y `mp4-muxer`, o,
 * si el navegador no tiene WebCodecs, se graba con `captureStream` + `MediaRecorder` (WebM) como respaldo.
 */
export function beginRecording() {
  if (active) return;
  const { ui } = store.getState();
  const mime = pickMime();
  const direct = hasWebCodecs();
  if (!direct && !mime) return fail('Este navegador no admite ningún formato de grabación compatible (WebCodecs ni MediaRecorder).');
  if (!direct && !('captureStream' in HTMLCanvasElement.prototype)) {
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
  mime: string | null,
  quality: 'light' | 'standard',
) {
  const project = store.getState().project;
  const { w: W, h: H } = STAGE_SIZES[project.format];
  const prevSpeed = playback.speed;
  const chunks: Blob[] = [];
  let recorder: MediaRecorder | null = null;
  let sink: Mp4Sink | null = null;
  let startedAt = 0;
  let stream: MediaStream | null = null;
  let finished = false;
  let startedRecording = false;
  let busy = false;
  let hasFrame = false;
  // Tipografías de los textos: se cargan antes de capturar y se incrustan en cada fotograma.
  const { used: usedFontList } = usedFonts(project);
  await loadFonts(usedFontList);
  await document.fonts.ready;
  const fontCss = await embeddedFontCss(project).catch(() => '');
  const withFonts = (svg: string) =>
    fontCss ? svg.replace(/^(<svg[^>]*>)/, `$1<defs><style>${fontCss}</style></defs>`) : svg;
  let tickTimer = 0;
  let endTimer = 0;
  const totalDuration = Math.max(sceneDuration(project), MIN_SECONDS);

  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const base = mk(); // fondo (se copia de forma síncrona)
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
    drawBackground(octx, W, H, store.getState().project);
    octx.drawImage(frame, 0, 0);
  };
  drawBackground(fctx, W, H, project);

  /** Dibuja el estado actual del runtime. Debe llamarse justo después de `renderAt`. */
  const grab = () => {
    if (busy || finished) return;
    busy = true;
    let snap: ReturnType<typeof runtime.snapshotScene>;
    try {
      drawBackground(bctx, W, H, store.getState().project);
      snap = runtime.snapshotScene(W, H);
    } catch {
      busy = false;
      return;
    }
    // `snap.svg` clona el SVG vivo de cada objeto con su `<defs data-mm-grad>`: los degradados (`fill="url(#mmg-…)"`)
    // viajan dentro del fotograma, tanto en la ruta normal como en el respaldo `snapshotScene(W, H, true)`.
    const toImage = async (svg: string) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      return img;
    };
    (async () => {
      let img: HTMLImageElement;
      try {
        img = await toImage(withFonts(snap.svg));
      } catch {
        // Respaldo: sin filtros, imágenes ni foreignObject, para que al menos las formas vectoriales se vean.
        img = await toImage(withFonts(runtime.snapshotScene(W, H, true).svg));
      }
      fctx.drawImage(base, 0, 0);
      fctx.drawImage(img, 0, 0, W, H);
      hasFrame = true;
    })()
      .catch(() => {
        // Si todo falla se conserva el fondo en lugar de un fotograma vacío.
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
    sink?.dispose();
    audio.releaseRecordingDestination();
    out.remove();
    active = null;
  };

  const deliver = (blob: Blob, ext: 'mp4' | 'webm') => {
    cleanup();
    if (!startedRecording || blob.size === 0) {
      fail('No se grabó ningún dato.');
      return;
    }
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

  const finalize = () => {
    if (finished) return;
    finished = true;
    setRec({ phase: 'finishing', message: sink ? 'Codificando MP4…' : 'Guardando archivo…' });
    if (sink) {
      const s = sink;
      window.clearInterval(tickTimer);
      paintOut();
      s.finish(performance.now() - startedAt, out)
        .then((blob) => deliver(blob, 'mp4'))
        .catch((e: unknown) => {
          cleanup();
          fail(`No se pudo codificar el MP4: ${e instanceof Error ? e.message : String(e)}`);
        });
      return;
    }
    const finish = () => deliver(new Blob(chunks, { type: (mime ?? 'video/webm').split(';')[0] }), (mime ?? '').startsWith('video/mp4') ? 'mp4' : 'webm');
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

  // 1) Primer fotograma limpio
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

  // 2) Canvas oculto → MP4 directo (WebCodecs); si no es posible, MediaRecorder con la mezcla de audio común
  const withAudio = !!project.voice || project.clips.some((clip) => clip.sound);
  try {
    sink = await createMp4Sink(W, H, quality, withAudio);
  } catch {
    sink = null;
  }
  if (finished) {
    sink?.dispose();
    return;
  }
  if (!sink) {
    if (!mime || !('captureStream' in HTMLCanvasElement.prototype)) {
      cleanup();
      return fail('Este navegador no puede codificar vídeo (ni WebCodecs ni MediaRecorder disponibles).');
    }
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
  }

  // Bucle de renderizado a 30 fps (temporizador, no rAF: sigue vivo con la pestaña en segundo plano).
  // Cada tick pinta fondo + último fotograma y lo envía al codificador (o pide un fotograma a la pista de vídeo).
  const videoTrack = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const pump = () => {
    if (finished) return;
    paintOut();
    if (sink) {
      sink.addFrame(out, performance.now() - startedAt);
      if (sink.error()) active?.stop('manual');
    } else if (recorder?.state === 'recording') videoTrack?.requestFrame?.();
  };
  startedAt = performance.now();
  pump();

  // 3) Grabar la duración real de la línea de tiempo (máx. de clips, voz y MIN_SECONDS), en tiempo real
  recorder?.start(500);
  startedRecording = true;
  setRec({ phase: 'recording', message: 'Grabando…', captureSize: { w: W, h: H } });
  startedAt = performance.now();
  tickTimer = window.setInterval(() => {
    pump();
    if (performance.now() - startedAt >= totalDuration * 1000 + 300) active?.stop('complete');
  }, 1000 / FPS);
  playback.onTick = () => grab(); // justo después de dibujar cada fotograma
  playback.onComplete = () => grab(); // la escena se queda en su último estado hasta totalDuration
  playback.play();
}
