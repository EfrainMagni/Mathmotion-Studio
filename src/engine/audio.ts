import type { Clip, SoundId, VoiceMeta } from '../types';

/** Motor de audio: efectos sintetizados, pista de voz y una mezcla común (master). */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  voiceBuffer: AudioBuffer | null = null;
  private live = new Set<() => void>();
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private mic: { rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number } | null = null;

  /** Debe llamarse desde un gesto del usuario la primera vez. */
  ensure(): AudioContext {
    if (!this.ctx) {
      const C: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Destino de grabación nuevo para cada captura; se alimenta de la misma mezcla. */
  createRecordingDestination(): MediaStreamAudioDestinationNode {
    const ctx = this.ensure();
    this.releaseRecordingDestination();
    const d = ctx.createMediaStreamDestination();
    this.master.connect(d);
    this.recDest = d;
    return d;
  }

  releaseRecordingDestination() {
    if (!this.recDest) return;
    try {
      this.master.disconnect(this.recDest);
    } catch {
      /* ya desconectado */
    }
    this.recDest.stream.getTracks().forEach((t) => t.stop());
    this.recDest = null;
  }

  // ---------- Efectos ----------

  private noise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuf) {
      const len = ctx.sampleRate * 4;
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = b;
    }
    return this.noiseBuf;
  }

  /** Reproduce un efecto en `when` (tiempo del AudioContext). Devuelve la función de cancelación. */
  playEffect(id: SoundId, when?: number, dur?: number): () => void {
    const ctx = this.ensure();
    const t = when ?? ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.connect(this.master);
    const cancel = () => {
      try {
        out.gain.cancelScheduledValues(0);
        out.gain.value = 0;
        out.disconnect();
      } catch {
        /* ya liberado */
      }
      this.live.delete(cancel);
    };
    this.live.add(cancel);
    let end = t + 0.3;

    const tone = (type: OscillatorType, f0: number, f1: number | null, at: number, len: number, peak: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, at);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + len * 0.7);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + len + 0.05);
      end = Math.max(end, at + len + 0.05);
    };

    switch (id) {
      case 'chalk': {
        const d = Math.min(Math.max(dur ?? 0.8, 0.2), 4);
        const src = ctx.createBufferSource();
        src.buffer = this.noise(ctx);
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600;
        bp.Q.value = 0.9;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1100;
        const g = ctx.createGain();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.type = 'sawtooth';
        lfo.frequency.value = 34;
        lfoGain.gain.value = 0.12;
        lfo.connect(lfoGain).connect(g.gain);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.28, t + 0.03);
        g.gain.setValueAtTime(0.28, t + Math.max(0.03, d - 0.08));
        g.gain.linearRampToValueAtTime(0, t + d);
        src.connect(bp).connect(hp).connect(g).connect(out);
        src.start(t, Math.random() * 2);
        src.stop(t + d + 0.05);
        lfo.start(t);
        lfo.stop(t + d + 0.05);
        end = t + d + 0.1;
        break;
      }
      case 'pop':
        tone('sine', 560, 190, t, 0.16, 0.55);
        break;
      case 'radar':
        tone('sine', 1046.5, null, t, 1.3, 0.38);
        tone('sine', 2093, null, t, 0.7, 0.1);
        tone('sine', 1046.5, null, t + 0.3, 1.0, 0.16);
        break;
      case 'sparkle':
        [1318.5, 1568, 1975.5, 2637].forEach((f, i) => tone('triangle', f, null, t + i * 0.07, 0.4, 0.22));
        break;
    }
    window.setTimeout(cancel, Math.max(0, (end - ctx.currentTime) * 1000) + 300);
    return cancel;
  }

  // ---------- Voz ----------

  async loadVoiceFile(file: File): Promise<{ duration: number; name: string }> {
    const ctx = this.ensure();
    const data = await file.arrayBuffer();
    let buf: AudioBuffer;
    try {
      buf = await ctx.decodeAudioData(data);
    } catch {
      throw new Error('No se pudo decodificar el audio. Prueba con MP3, WAV, OGG o M4A.');
    }
    this.voiceBuffer = buf;
    return { duration: buf.duration, name: file.name };
  }

  clearVoice() {
    this.voiceBuffer = null;
  }

  get micRecording() {
    return this.mic !== null;
  }

  micElapsed(): number {
    return this.mic ? (performance.now() - this.mic.startedAt) / 1000 : 0;
  }

  async startMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite acceder al micrófono.');
    if (typeof MediaRecorder === 'undefined') throw new Error('Este navegador no admite MediaRecorder.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const n = (e as DOMException).name;
      if (n === 'NotAllowedError' || n === 'SecurityError') throw new Error('Permiso de micrófono denegado.');
      if (n === 'NotFoundError') throw new Error('No se encontró ningún micrófono.');
      throw new Error('No se pudo abrir el micrófono.');
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    this.mic = { rec, stream, chunks, startedAt: performance.now() };
  }

  async stopMic(): Promise<{ duration: number; name: string }> {
    const m = this.mic;
    if (!m) throw new Error('No hay una grabación de voz en curso.');
    this.mic = null;
    await new Promise<void>((res) => {
      m.rec.onstop = () => res();
      m.rec.stop();
    });
    m.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(m.chunks, { type: m.rec.mimeType || 'audio/webm' });
    if (!blob.size) throw new Error('La grabación de voz quedó vacía.');
    const ctx = this.ensure();
    try {
      this.voiceBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      throw new Error('No se pudo procesar la grabación de voz.');
    }
    return { duration: this.voiceBuffer.duration, name: `Voz ${new Date().toLocaleTimeString()}` };
  }

  cancelMic() {
    const m = this.mic;
    if (!m) return;
    this.mic = null;
    try {
      m.rec.stop();
    } catch {
      /* ya detenido */
    }
    m.stream.getTracks().forEach((t) => t.stop());
  }

  // ---------- Reproducción sincronizada ----------

  /**
   * Programa voz y efectos pendientes a partir del instante `t` de la línea de tiempo.
   * Los efectos que ya empezaron (start < t) no se disparan.
   */
  start(t: number, speed: number, voice: VoiceMeta | null, clips: Clip[]) {
    const ctx = this.ensure();
    this.cancel();
    const now = ctx.currentTime + 0.02;
    if (voice && this.voiceBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.voiceBuffer;
      src.playbackRate.value = speed;
      const g = ctx.createGain();
      g.gain.value = voice.volume;
      src.connect(g).connect(this.master);
      const offset = t - voice.start;
      let started = false;
      if (offset < 0) {
        src.start(now + -offset / speed, 0);
        started = true;
      } else if (offset < this.voiceBuffer.duration) {
        src.start(now, offset);
        started = true;
      }
      if (started) {
        const stop = () => {
          try {
            src.stop();
          } catch {
            /* no iniciado o ya detenido */
          }
          try {
            src.disconnect();
            g.disconnect();
          } catch {
            /* ya liberado */
          }
          this.live.delete(stop);
        };
        src.onended = stop;
        this.live.add(stop);
      }
    }
    for (const c of clips) {
      if (c.sound && c.start >= t - 1e-3) {
        const dur = c.type === 'draw' ? c.duration / speed : undefined;
        this.playEffect(c.sound, now + (c.start - t) / speed, dur);
      }
    }
  }

  /** Cancela todo el audio programado o en curso (pausa, reinicio, salto). */
  cancel() {
    Array.from(this.live).forEach((f) => f());
    this.live.clear();
  }
}
