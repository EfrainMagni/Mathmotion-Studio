import { SFX_VOLUME_MAX, SOUND_META, soundDuration, type Clip, type SfxClip, type SoundId, type VoiceMeta } from '../types';

/** PRNG determinista (mulberry32): el mismo patrón suena igual en vivo y en la exportación. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Motor de audio: efectos sintetizados, pista de voz y una mezcla común (master). */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private _master: GainNode | null = null;
  /** Efectos sueltos de la pista «Efectos» (los mantiene al día `Timeline.tsx` desde el store). */
  private timelineSfx: readonly SfxClip[] = [];
  private voiceBuffers = new WeakMap<Blob, AudioBuffer>();
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
      this._master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Bus de mezcla común (voz + efectos). */
  get master(): GainNode {
    return this._master!;
  }

  /**
   * `recorder.ts` (mezcla offline del `.mp4`) apunta temporalmente `ensure()` y `master` a un `OfflineAudioContext`
   * y programa ahí los sonidos de los clips. Al recibir un bus offline se programan también los efectos sueltos, con
   * la misma lógica que en vivo, para que la exportación suene idéntica a la reproducción.
   */
  set master(node: GainNode) {
    this._master = node;
    const ctx = node?.context;
    if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext && this.timelineSfx.length) {
      this.scheduleEffects([], this.timelineSfx, { from: 0, at: 0, until: ctx.length / ctx.sampleRate });
    }
  }

  /** Sincroniza la lista de efectos sueltos del proyecto (reproducción en vivo y exportación). */
  setTimelineSfx(list: readonly SfxClip[] | undefined) {
    this.timelineSfx = list ?? [];
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

  private noise(ctx: BaseAudioContext): AudioBuffer {
    if (!this.noiseBuf) {
      const len = ctx.sampleRate * 4;
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = b;
    }
    return this.noiseBuf;
  }

  /**
   * Reproduce un efecto en `when` (tiempo del contexto activo). Devuelve la función de cancelación.
   * Funciona igual con el `AudioContext` en vivo y con el `OfflineAudioContext` de la exportación `.mp4`
   * (`recorder.ts` apunta `ensure()` y `master` al contexto offline): toda la síntesis se programa con tiempos
   * absolutos del contexto y nada depende del reloj real salvo la liberación de nodos en vivo.
   * `dur` solo se usa en efectos ajustables (`SOUND_META[id].resizable`); `volume` escala la salida (0–1.5).
   */
  playEffect(id: SoundId, when?: number, dur?: number, volume = 1): () => void {
    const ctx: BaseAudioContext = this.ensure();
    const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    const t = Math.max(when ?? ctx.currentTime + 0.01, offline ? 0 : ctx.currentTime);
    const out = ctx.createGain();
    out.gain.value = Math.min(SFX_VOLUME_MAX, Math.max(0, Number.isFinite(volume) ? volume : 1));
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
    let end = t + 0.3;

    // Envolvente sin clics: parte de casi cero, sube en `attack` y cae exponencialmente hasta `at + len`.
    const env = (g: GainNode, at: number, len: number, peak: number, attack = 0.008) => {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(len, attack + 0.005));
      g.gain.setValueAtTime(0, at + Math.max(len, attack + 0.005) + 0.01);
    };
    const filter = (type: BiquadFilterType, freq: number, q = 0.707) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
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
    /** Oscilador con glissando exponencial `f0 → f1` en `glide` s, envolvente limpia y destino configurable. */
    const voice = (
      type: OscillatorType, f0: number, f1: number | null, at: number, len: number, peak: number,
      opts: { attack?: number; glide?: number; dest?: AudioNode; detune?: number } = {},
    ) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      if (opts.detune) o.detune.value = opts.detune;
      o.frequency.setValueAtTime(f0, at);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, at + (opts.glide ?? len * 0.7));
      env(g, at, len, peak, opts.attack);
      o.connect(g).connect(opts.dest ?? out);
      o.start(at);
      o.stop(at + len + 0.05);
      end = Math.max(end, at + len + 0.06);
      return o;
    };
    /** Fuente de ruido blanco (en bucle) entre `at` y `at + len`. */
    const noiseSrc = (at: number, len: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise(ctx);
      src.loop = true;
      src.start(at, (at * 7.31) % 3);
      src.stop(at + len + 0.05);
      end = Math.max(end, at + len + 0.06);
      return src;
    };

    switch (id) {
      // ---------- Originales (sin cambios: los proyectos guardados suenan igual) ----------
      case 'chalk': {
        const d = soundDuration('chalk', dur);
        const src = noiseSrc(t, d);
        const bp = filter('bandpass', 2600, 0.9);
        const hp = filter('highpass', 1100);
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

      // ---------- Escritura / Robot / Computadora ----------
      case 'robot-type': {
        // Ráfaga de pulsos digitales cortos con FM. Patrón pseudoaleatorio determinista (misma secuencia en vivo
        // y en la exportación) y paso de banda para que suene a terminal, no a zumbido.
        const d = soundDuration('robot-type', dur);
        const bus = filter('lowpass', 5200, 0.6);
        const bp = filter('bandpass', 1900, 0.8);
        bus.connect(bp).connect(out);
        const rand = mulberry32(0x5eed + Math.round(d * 1000));
        const notes = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3];
        let at = t + 0.004;
        while (at < t + d - 0.03) {
          const f = notes[Math.floor(rand() * notes.length)];
          const len = 0.016 + rand() * 0.014;
          const carrier = voice('square', f, null, at, len, 0.075 + rand() * 0.03, { attack: 0.003, dest: bus });
          const mod = ctx.createOscillator();
          const modGain = ctx.createGain();
          mod.frequency.value = f * (rand() < 0.5 ? 1.5 : 2.01);
          modGain.gain.value = f * (0.25 + rand() * 0.35);
          mod.connect(modGain).connect(carrier.frequency);
          mod.start(at);
          mod.stop(at + len + 0.05);
          // Cadencia irregular de tecleo: ráfagas rápidas y alguna pausa breve.
          at += rand() < 0.12 ? 0.07 + rand() * 0.05 : 0.032 + rand() * 0.026;
        }
        end = Math.max(end, t + d + 0.08);
        break;
      }
      case 'tech-blip': {
        const lp = filter('lowpass', 6500);
        lp.connect(out);
        voice('triangle', 1318.5, null, t, 0.065, 0.28, { attack: 0.004, dest: lp });
        voice('sine', 2637, null, t, 0.05, 0.05, { attack: 0.004, dest: lp });
        voice('triangle', 1760, null, t + 0.075, 0.11, 0.3, { attack: 0.004, dest: lp });
        voice('sine', 3520, null, t + 0.075, 0.07, 0.05, { attack: 0.004, dest: lp });
        break;
      }

      // ---------- Puntos, vértices y selección ----------
      case 'dot-pop': {
        const lp = filter('lowpass', 3200);
        lp.connect(out);
        voice('sine', 320, 980, t, 0.17, 0.5, { attack: 0.005, glide: 0.06, dest: lp });
        voice('triangle', 160, 490, t, 0.12, 0.12, { attack: 0.005, glide: 0.06, dest: lp });
        break;
      }
      case 'tick-click': {
        const bp = filter('bandpass', 3600, 2.2);
        const g = ctx.createGain();
        env(g, t, 0.012, 0.55, 0.001);
        noiseSrc(t, 0.03).connect(bp).connect(g).connect(out);
        voice('sine', 2400, 1800, t, 0.03, 0.22, { attack: 0.001, glide: 0.02 });
        break;
      }

      // ---------- Aparición y transformación ----------
      case 'appear-chime': {
        // Acorde de Do mayor agudo con un parcial inarmónico tenue por nota (brillo cristalino) y cola corta.
        const lp = filter('lowpass', 9000);
        lp.connect(out);
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
          const at = t + i * 0.018;
          voice('sine', f, null, at, 1.15 - i * 0.12, 0.1, { attack: 0.012, dest: lp });
          voice('triangle', f * 2, null, at, 0.5, 0.025, { attack: 0.012, dest: lp, detune: 4 });
          voice('sine', f * 2.76, null, at, 0.3, 0.012, { attack: 0.01, dest: lp });
        });
        break;
      }
      case 'whoosh-morph': {
        const d = soundDuration('whoosh-morph', dur);
        const bp = filter('bandpass', 400, 1.3);
        bp.frequency.setValueAtTime(400, t);
        bp.frequency.exponentialRampToValueAtTime(2400, t + d * 0.6);
        bp.frequency.exponentialRampToValueAtTime(900, t + d);
        const lp = filter('lowpass', 6000);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.42, t + d * 0.5);
        g.gain.linearRampToValueAtTime(0, t + d);
        noiseSrc(t, d).connect(bp).connect(lp).connect(g).connect(out);
        break;
      }
      case 'spotlight-hum': {
        const d = soundDuration('spotlight-hum', dur);
        const lp = filter('lowpass', 700, 0.5);
        const g = ctx.createGain();
        const fadeIn = Math.min(0.18, d * 0.3);
        const hold = t + Math.max(fadeIn, d * 0.6);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.24, t + fadeIn);
        g.gain.setValueAtTime(0.24, hold);
        g.gain.linearRampToValueAtTime(0, t + d);
        // Trémolo suave de 4 Hz para que «respire»: modula una etapa propia (ganancia 1 ± 0.2) tras la
        // envolvente, así fuera de la envolvente sigue habiendo silencio absoluto.
        const trem = ctx.createGain();
        trem.gain.value = 1;
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 4;
        depth.gain.value = 0.2;
        lfo.connect(depth).connect(trem.gain);
        lfo.start(t);
        lfo.stop(t + d + 0.05);
        g.connect(trem).connect(lp).connect(out);
        for (const [type, f, level] of [['sine', 110, 1], ['sine', 220, 0.45], ['triangle', 165, 0.25]] as const) {
          const o = ctx.createOscillator();
          const og = ctx.createGain();
          o.type = type;
          o.frequency.setValueAtTime(f * 1.02, t);
          o.frequency.exponentialRampToValueAtTime(f, t + fadeIn);
          og.gain.value = level;
          o.connect(og).connect(g);
          o.start(t);
          o.stop(t + d + 0.05);
        }
        end = Math.max(end, t + d + 0.08);
        break;
      }

      // ---------- Salida y desaparición ----------
      case 'disappear-whoosh': {
        const d = SOUND_META['disappear-whoosh'].duration;
        const bp = filter('bandpass', 2200, 1.1);
        bp.frequency.setValueAtTime(2200, t);
        bp.frequency.exponentialRampToValueAtTime(250, t + d);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.36, t + d * 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        g.gain.setValueAtTime(0, t + d + 0.01);
        noiseSrc(t, d).connect(bp).connect(g).connect(out);
        voice('sine', 620, 150, t, d * 0.9, 0.06, { attack: 0.03, glide: d * 0.85 });
        break;
      }
      case 'shrink-zip': {
        const lp = filter('lowpass', 5000, 5);
        lp.frequency.setValueAtTime(5000, t);
        lp.frequency.exponentialRampToValueAtTime(400, t + 0.3);
        lp.connect(out);
        voice('sawtooth', 1800, 120, t, 0.3, 0.12, { attack: 0.004, glide: 0.28, dest: lp });
        voice('triangle', 1200, 90, t, 0.3, 0.18, { attack: 0.004, glide: 0.28, dest: lp });
        break;
      }
      case 'success-bell': {
        // Nota de campana limpia (Sol5) con parciales armónicos que decaen más rápido cuanto más agudos.
        const lp = filter('lowpass', 8000);
        lp.connect(out);
        const f0 = 783.99;
        ([[1, 0.3, 1.8], [2, 0.12, 1.25], [3, 0.06, 0.85], [4.2, 0.03, 0.5], [5.4, 0.012, 0.3]] as const)
          .forEach(([ratio, peak, len]) => voice('sine', f0 * ratio, null, t, len, peak, { attack: 0.005, dest: lp }));
        break;
      }
    }
    if (!offline) {
      // En vivo se liberan los nodos al terminar; en offline el grafo muere con el contexto al renderizar.
      this.live.add(cancel);
      window.setTimeout(cancel, Math.max(0, (end - ctx.currentTime) * 1000) + 300);
    }
    return cancel;
  }

  /**
   * Programa todos los efectos de la línea de tiempo (sonidos asociados a clips y efectos sueltos) que empiezan
   * en `[from, until)`. `at` es el instante del contexto que corresponde a `from`. Lo usan la reproducción en vivo
   * (`start`) y la mezcla offline de la exportación `.mp4` (vía el setter de `master`), así ambas suenan idénticas.
   */
  scheduleEffects(clips: readonly Clip[], sfx: readonly SfxClip[] | undefined, opts: { from: number; at: number; speed?: number; until?: number }) {
    const speed = opts.speed ?? 1;
    const until = opts.until ?? Infinity;
    const due = (start: number) => start >= opts.from - 1e-3 && start < until;
    for (const c of clips) {
      if (!c.sound || !due(c.start)) continue;
      // Igual que la mezcla offline de `recorder.ts`: un sonido asociado se estira con su clip en Write / Create
      // (tiza, escritura robótica…); en el resto suena con su duración natural.
      this.playEffect(c.sound, opts.at + (c.start - opts.from) / speed, c.type === 'draw' ? c.duration / speed : undefined);
    }
    for (const s of sfx ?? []) {
      if (!due(s.start)) continue;
      this.playEffect(s.sound, opts.at + (s.start - opts.from) / speed, s.duration / speed, s.volume);
    }
  }

  // ---------- Voz ----------

  async decodeVoice(source: Blob): Promise<AudioBuffer> {
    const cached = this.voiceBuffers.get(source);
    if (cached) return cached;
    try {
      const decoder = this.ctx ?? new OfflineAudioContext(1, 1, 44100);
      const buffer = await decoder.decodeAudioData(await source.arrayBuffer());
      this.voiceBuffers.set(source, buffer);
      return buffer;
    } catch {
      throw new Error('No se pudo decodificar el audio. Prueba con MP3, WAV, OGG o M4A.');
    }
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

  async stopMic(): Promise<{ buffer: AudioBuffer; source: Blob; name: string }> {
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
    const buffer = await this.decodeVoice(blob);
    return { buffer, source: blob, name: `Voz ${new Date().toLocaleTimeString()}` };
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
   * Los efectos que ya empezaron (start < t) no se disparan. `sfx` son los efectos sueltos de la pista «Efectos».
   */
  start(t: number, speed: number, voice: VoiceMeta | null, clips: Clip[], sfx: readonly SfxClip[] = this.timelineSfx) {
    const ctx = this.ensure();
    this.cancel();
    const now = ctx.currentTime + 0.02;
    const buffer = voice && this.voiceBuffers.get(voice.source);
    if (voice && buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = speed;
      const g = ctx.createGain();
      g.gain.value = voice.volume;
      src.connect(g).connect(this.master);
      const offset = t - voice.start;
      let started = false;
      if (offset < 0) {
        src.start(now + -offset / speed, 0);
        started = true;
      } else if (offset < buffer.duration) {
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
    this.scheduleEffects(clips, sfx, { from: t, at: now, speed });
  }

  /** Cancela todo el audio programado o en curso (pausa, reinicio, salto). */
  cancel() {
    Array.from(this.live).forEach((f) => f());
    this.live.clear();
  }
}
