import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  SCENE_GRID_LINE_WIDTH, STAGE_SIZES, resolveSceneBackground, sceneBackgroundGeometry, sceneDuration,
  type Project, type RecordQuality,
} from '../types';
import { actions, store } from '../store';
import { audio, engine } from './index';
import { embeddedFontCss, loadFonts, usedFonts } from './fonts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Respaldo con `MediaRecorder` (navegadores sin `VideoEncoder`). Orden de preferencia: WebM (VP9/VP8) primero, porque
 * en Chrome/Edge sobre Windows siempre genera una pista de vídeo válida; MP4 (H.264) solo como último recurso.
 * La vía principal es MP4 (H.264) con `VideoEncoder` + `mp4-muxer`, renderizada fotograma a fotograma (determinista).
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

/** Duración mínima de cualquier grabación (también la de una escena estática). */
const MIN_SECONDS = 3;

/** Frecuencia de muestreo de la mezcla de audio offline. */
const AUDIO_RATE = 48_000;

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export const QUALITY: Record<RecordQuality, { fps: number; video: number; audio: number; label: string }> = {
  light: { fps: 30, video: 3_000_000, audio: 128_000, label: 'Ligera (30 fps · 3 Mbps)' },
  standard: { fps: 30, video: 6_000_000, audio: 160_000, label: 'Estándar (30 fps · 6 Mbps)' },
  hd: { fps: 60, video: 14_000_000, audio: 192_000, label: 'Alta Calidad HD (60 fps · 14 Mbps)' },
  max: { fps: 60, video: 24_000_000, audio: 256_000, label: 'Máxima Calidad (60 fps · 24 Mbps)' },
};

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

const yieldThread = () => new Promise<void>((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ MP4 directo (WebCodecs + mp4-muxer)

/** `true` si el navegador ofrece WebCodecs para vídeo (la codificación H.264 concreta se comprueba al crear el sumidero). */
export function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

interface Mp4Sink {
  /** Codifica el canvas como fotograma `index` con marca de tiempo y duración exactas (espera si la cola se llena). */
  encodeFrame(canvas: HTMLCanvasElement, index: number): Promise<void>;
  /** Codifica la mezcla de audio completa, recortada o rellenada a `seconds`. */
  encodeAudio(mix: AudioBuffer, seconds: number): Promise<void>;
  /** Vacía los codificadores, cierra el contenedor y devuelve el `.mp4`. */
  finish(): Promise<Blob>;
  /** Libera codificadores sin producir archivo. Es idempotente. */
  dispose(): void;
  error(): Error | null;
}

async function createMp4Sink(W: number, H: number, quality: RecordQuality, withAudio: boolean): Promise<Mp4Sink | null> {
  if (!hasWebCodecs()) return null;
  const q = QUALITY[quality];
  const fps = q.fps;

  let videoCfg: VideoEncoderConfig | null = null;
  // H.264 nivel 4.2 (1080p a 60 fps), luego 5.1 y 4.0 como alternativas; High → Main → Baseline.
  const codecs = ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.640033', 'avc1.4d0033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e028'];
  for (const codec of codecs) {
    const cfg: VideoEncoderConfig = {
      codec, width: W, height: H, bitrate: q.video, bitrateMode: 'variable', framerate: fps,
      latencyMode: 'quality', avc: { format: 'avc' },
    };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => null))?.supported) {
      videoCfg = cfg;
      break;
    }
  }
  if (!videoCfg) return null;

  let audioCfg: AudioEncoderConfig | null = null;
  let audioCodec: 'aac' | 'opus' = 'aac';
  if (withAudio) {
    // Sin AudioEncoder se prefiere el respaldo de MediaRecorder antes que perder la voz.
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || typeof OfflineAudioContext === 'undefined') return null;
    for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']] as const) {
      const cfg: AudioEncoderConfig = { codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: q.audio };
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
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    ...(audioCfg ? { audio: { codec: audioCodec, numberOfChannels: 2, sampleRate: AUDIO_RATE } } : {}),
  });

  let failure: Error | null = null;
  const onError = (e: Error) => {
    failure ??= e;
  };
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: onError });
  venc.configure(videoCfg);
  let aenc: AudioEncoder | null = null;
  if (audioCfg) {
    aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: onError });
    aenc.configure(audioCfg);
  }

  const frameDuration = Math.round(1_000_000 / fps);
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (venc.state !== 'closed') venc.close();
    if (aenc && aenc.state !== 'closed') aenc.close();
  };

  return {
    error: () => failure,
    dispose,
    async encodeFrame(canvas, index) {
      if (disposed || venc.state !== 'configured') return;
      // Contrapresión: nunca se descartan fotogramas, se espera a que el codificador libere la cola.
      while (venc.encodeQueueSize > 4 && !failure) await new Promise((r) => setTimeout(r, 1));
      const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1_000_000) / fps), duration: frameDuration });
      venc.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
    },
    async encodeAudio(mix, seconds) {
      if (!aenc || aenc.state !== 'configured') return;
      const total = Math.round(seconds * AUDIO_RATE);
      const L = mix.getChannelData(0);
      const R = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
      const CHUNK = 4096;
      for (let off = 0; off < total; off += CHUNK) {
        const n = Math.min(CHUNK, total - off);
        const data = new Float32Array(n * 2); // planar: [L…, R…]; lo que exceda la mezcla queda en silencio
        const avail = Math.max(0, Math.min(n, L.length - off));
        if (avail > 0) {
          data.set(L.subarray(off, off + avail), 0);
          data.set(R.subarray(off, off + avail), n);
        }
        const ad = new AudioData({
          format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2,
          timestamp: Math.round((off / AUDIO_RATE) * 1e6), data,
        });
        aenc.encode(ad);
        ad.close();
        if (aenc.encodeQueueSize > 32) await yieldThread();
      }
    },
    async finish() {
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

/**
 * Mezcla offline (voz + efectos) de la línea de tiempo con la duración exacta del vídeo.
 * Reutiliza la síntesis de efectos del motor de audio apuntándolo temporalmente a un `OfflineAudioContext`.
 */
async function renderAudioMix(project: Project, seconds: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * AUDIO_RATE)), AUDIO_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.9; // misma ganancia que el master en vivo
  master.connect(ctx.destination);
  const voice = project.voice;
  if (voice) {
    const buffer = await audio.decodeVoice(voice.source);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = voice.volume;
    src.connect(g).connect(master);
    const offset = Math.max(0, -voice.start);
    if (offset < buffer.duration) src.start(Math.max(0, voice.start), offset);
  }
  const eng = audio as any;
  const prev = { ensure: eng.ensure, master: eng.master };
  eng.ensure = () => ctx; // evita `resume()` sobre el contexto offline
  eng.master = master;
  try {
    for (const c of project.clips) {
      if (c.sound && c.start < seconds) audio.playEffect(c.sound, c.start, c.type === 'draw' ? c.duration : undefined);
    }
  } finally {
    if (prev.ensure === Object.getPrototypeOf(audio).ensure) delete eng.ensure;
    else eng.ensure = prev.ensure;
    eng.master = prev.master;
  }
  return ctx.startRendering();
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

const mkCanvas = (W: number, H: number) => {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
};

const hq = (ctx: CanvasRenderingContext2D) => {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
};

const svgToImage = async (svg: string) => {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
};

/**
 * Inicia la grabación del escenario. No usa la captura de pantalla: cada fotograma se dibuja en un canvas oculto
 * a la resolución lógica del escenario (1920×1080 o 1080×1920, sin interfaz).
 * - Vía principal (WebCodecs): render determinista fotograma a fotograma (`t = i / fps`), H.264 + AAC con `mp4-muxer`.
 * - Respaldo (sin WebCodecs): `captureStream` + `MediaRecorder` (WebM) en tiempo real.
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

type Runtime = NonNullable<typeof engine.runtime>;
type Playback = NonNullable<typeof engine.playback>;

async function run(runtime: Runtime, playback: Playback, mime: string | null, quality: RecordQuality) {
  const project = store.getState().project;
  const { w: W, h: H } = STAGE_SIZES[project.format];
  const withAudio = !!project.voice || project.clips.some((clip) => clip.sound);
  let cancelled = false;
  active = { stop: () => { cancelled = true; } };
  setRec({ phase: 'preparing', message: 'Preparando la grabación…', captureSize: { w: W, h: H } });

  // Tipografías de los textos: se cargan antes de capturar y se incrustan en cada fotograma.
  const { used: usedFontList } = usedFonts(project);
  await loadFonts(usedFontList);
  await document.fonts.ready;
  // Incluye cualquiera de las 11 familias del catálogo (p. ej. Montserrat, Poppins, Raleway, Merriweather,
  // Libre Baskerville): sin su `@font-face` incrustado el fotograma rasterizado caería en la fuente de respaldo.
  const fontCss = await embeddedFontCss(project).catch(() => '');
  const missingFonts = [...new Set(usedFontList.map((u) => u.family))].filter((family) => !fontCss.includes(`'${family}'`));
  if (missingFonts.length) console.warn('[recorder] Sin @font-face incrustado (se usará la fuente de respaldo):', missingFonts.join(', '));
  const withFonts = (svg: string) =>
    fontCss ? svg.replace(/^(<svg[^>]*>)/, `$1<defs><style>${fontCss}</style></defs>`) : svg;

  let sink: Mp4Sink | null = null;
  try {
    sink = await createMp4Sink(W, H, quality, withAudio);
  } catch {
    sink = null;
  }
  if (cancelled) {
    sink?.dispose();
    active = null;
    setRec({ phase: 'idle', message: null, captureSize: null });
    return;
  }
  if (sink) return runDeterministic(runtime, playback, sink, quality, withFonts, () => cancelled);
  if (!mime || !('captureStream' in HTMLCanvasElement.prototype)) {
    active = null;
    return fail('Este navegador no puede codificar vídeo (ni WebCodecs ni MediaRecorder disponibles).');
  }
  return runRealtime(runtime, playback, mime, quality, withFonts);
}

function deliver(blob: Blob, ext: 'mp4' | 'webm') {
  if (blob.size === 0) {
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
}

/** Dibuja el estado actual del runtime (fondo + escena) en `ctx`, esperando a que la imagen SVG esté decodificada. */
async function drawScene(
  runtime: Runtime, ctx: CanvasRenderingContext2D, W: number, H: number, withFonts: (svg: string) => string,
) {
  const snap = runtime.snapshotScene(W, H);
  let img: HTMLImageElement | null = null;
  try {
    img = await svgToImage(withFonts(snap.svg));
  } catch {
    // Respaldo: sin filtros, imágenes ni foreignObject, para que al menos las formas vectoriales se vean.
    img = await svgToImage(withFonts(runtime.snapshotScene(W, H, true).svg)).catch(() => null);
  }
  hq(ctx);
  // Fondo sólido en cada fotograma: la pista de vídeo nunca queda vacía ni transparente.
  drawBackground(ctx, W, H, store.getState().project);
  if (img) ctx.drawImage(img, 0, 0, W, H);
}

/**
 * Render determinista: el tiempo de la escena avanza exactamente `1 / fps` por fotograma, sin depender del reloj real,
 * así ningún fotograma se pierde aunque la escena (cuadrículas, MathJax) tarde en dibujarse.
 */
async function runDeterministic(
  runtime: Runtime, playback: Playback, sink: Mp4Sink, quality: RecordQuality,
  withFonts: (svg: string) => string, isCancelled: () => boolean,
) {
  const project = store.getState().project;
  const { w: W, h: H } = STAGE_SIZES[project.format];
  const { fps } = QUALITY[quality];
  const duration = Math.max(sceneDuration(project), MIN_SECONDS);
  const totalFrames = Math.round(duration * fps);
  const prevTime = playback.time;
  const canvas = mkCanvas(W, H);
  const ctx = hq(canvas.getContext('2d', { alpha: false })!);
  let manualStop = false;
  active = { stop: (reason) => { if (reason === 'manual') manualStop = true; } };
  const cleanup = () => {
    sink.dispose();
    playback.seek(Math.min(prevTime, playback.duration));
    active = null;
  };
  playback.pause();
  setRec({ phase: 'recording', message: 'Renderizando… 0 %', captureSize: { w: W, h: H } });

  let rendered = 0;
  try {
    for (let i = 0; i <= totalFrames; i++) {
      if (manualStop || isCancelled()) break;
      const t = Math.min(i / fps, duration);
      playback.seek(t); // evalúa la escena en el instante exacto (sin disparar sonidos)
      await drawScene(runtime, ctx, W, H, withFonts);
      await sink.encodeFrame(canvas, i);
      rendered = i + 1;
      const err = sink.error();
      if (err) throw err;
      if (i % 2 === 0 || i === totalFrames) {
        setRec({ message: `Renderizando… ${Math.round((rendered / (totalFrames + 1)) * 100)} % (${rendered}/${totalFrames + 1})` });
      }
      await yieldThread(); // cede el hilo: la UI se actualiza sin congelarse
    }
    if (rendered === 0) {
      cleanup();
      setRec({ phase: 'idle', message: null, captureSize: null });
      return;
    }
    setRec({ phase: 'finishing', message: 'Codificando MP4…' });
    const videoSeconds = rendered / fps;
    if (project.voice || project.clips.some((c) => c.sound)) {
      setRec({ message: 'Mezclando audio…' });
      const mix = await renderAudioMix(project, videoSeconds);
      await sink.encodeAudio(mix, videoSeconds);
    }
    const blob = await sink.finish();
    cleanup();
    deliver(blob, 'mp4');
  } catch (e) {
    cleanup();
    fail(`No se pudo codificar el MP4: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Respaldo en tiempo real con `MediaRecorder` para navegadores sin WebCodecs. */
async function runRealtime(
  runtime: Runtime, playback: Playback, mime: string, quality: RecordQuality, withFonts: (svg: string) => string,
) {
  const project = store.getState().project;
  const { w: W, h: H } = STAGE_SIZES[project.format];
  const q = QUALITY[quality];
  const fps = q.fps;
  const prevSpeed = playback.speed;
  const totalDuration = Math.max(sceneDuration(project), MIN_SECONDS);
  const chunks: Blob[] = [];
  let finished = false;
  let busy = false;
  let hasFrame = false;
  let tickTimer = 0;

  const frame = mkCanvas(W, H); // último fotograma completo
  const out = mkCanvas(W, H); // el que se captura
  out.setAttribute('aria-hidden', 'true');
  out.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(out);
  const fctx = hq(frame.getContext('2d')!);
  const octx = hq(out.getContext('2d')!);
  drawBackground(fctx, W, H, project);

  const grab = () => {
    if (busy || finished) return;
    busy = true;
    const tmp = mkCanvas(W, H);
    drawScene(runtime, tmp.getContext('2d')!, W, H, withFonts)
      .then(() => {
        fctx.drawImage(tmp, 0, 0);
        hasFrame = true;
      })
      .catch(() => {
        hasFrame = true;
      })
      .finally(() => {
        busy = false;
      });
  };

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  const cleanup = () => {
    window.clearInterval(tickTimer);
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
      cleanup();
      deliver(new Blob(chunks, { type: mime.split(';')[0] }), mime.startsWith('video/mp4') ? 'mp4' : 'webm');
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
  active = { stop: () => finalize() };

  playback.restart();
  playback.setSpeed(1);
  grab();
  const t0 = performance.now();
  while (!hasFrame && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 16));
  if (finished) return;
  if (!hasFrame) {
    finished = true;
    cleanup();
    return fail('No se pudo dibujar el escenario en el canvas de grabación.');
  }

  try {
    stream = out.captureStream(fps);
    const dest = audio.createRecordingDestination();
    const mixed = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: q.video, audioBitsPerSecond: q.audio });
  } catch (e) {
    finished = true;
    cleanup();
    return fail(`No se pudo crear el grabador (${mime}): ${(e as Error).message}`);
  }
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onerror = () => finalize();

  const videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const pump = () => {
    if (finished) return;
    drawBackground(octx, W, H, store.getState().project);
    octx.drawImage(frame, 0, 0);
    if (recorder?.state === 'recording') videoTrack.requestFrame?.();
  };
  recorder.start(500);
  setRec({ phase: 'recording', message: 'Grabando…', captureSize: { w: W, h: H } });
  const startedAt = performance.now();
  pump();
  tickTimer = window.setInterval(() => {
    pump();
    if (performance.now() - startedAt >= totalDuration * 1000 + 300) finalize();
  }, 1000 / fps);
  playback.onTick = () => grab();
  playback.onComplete = () => grab();
  playback.play();
}
