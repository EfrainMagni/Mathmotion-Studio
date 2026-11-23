import { gsap } from 'gsap';
import { FPS, sceneDuration, type Project } from '../types';
import type { AudioEngine } from './audio';
import type { SceneRuntime } from './runtime';

export interface PlaybackHooks {
  getProject: () => Project;
  onTime: (t: number) => void;
  onPlaying: (playing: boolean) => void;
}

/**
 * Línea de tiempo maestra (GSAP). Es la referencia de tiempo para SVG, Three.js y audio:
 * cada fotograma, `renderAt(tl.time())` dibuja el escenario y el audio se programa contra
 * la misma posición del cabezal.
 */
export class Playback {
  private tl: gsap.core.Timeline | null = null;
  private _duration = 0.5;
  private _speed = 1;
  playing = false;
  /** Se llama en cada fotograma tras dibujar (la grabación lo usa para espejar el tiempo). */
  onTick: ((t: number) => void) | null = null;
  /** Se llama al llegar al final de la escena. */
  onComplete: (() => void) | null = null;

  constructor(
    private runtime: SceneRuntime,
    private audio: AudioEngine,
    private hooks: PlaybackHooks,
  ) {}

  get duration() {
    return this._duration;
  }
  get speed() {
    return this._speed;
  }
  get time() {
    return this.tl ? this.tl.time() : 0;
  }

  /**
   * Reconstruye la línea de tiempo al editar clips: parte del estado base del escenario
   * y restaura la posición del cabezal.
   */
  rebuild(p: Project) {
    const keep = this.tl ? this.tl.time() : this.runtime.time;
    const wasPlaying = this.playing;
    if (this.tl) {
      this.tl.kill();
      this.tl = null;
    }
    if (wasPlaying) {
      this.audio.cancel();
      this.playing = false;
    }
    this.runtime.resetBase();

    const end = sceneDuration(p);
    this._duration = end;
    const tl = gsap.timeline({
      paused: true,
      onUpdate: () => this.tick(),
      onComplete: () => this.finish(),
    });
    const clock = { t: 0 };
    tl.to(clock, { t: end, duration: end, ease: 'none' }, 0);
    for (const c of p.clips) {
      tl.to({ p: 0 }, { p: 1, duration: Math.max(c.duration, 0.0001), ease: 'none' }, c.start);
    }
    tl.timeScale(this._speed);
    this.tl = tl;
    tl.time(Math.min(keep, end), true);
    this.tick();
    if (wasPlaying) {
      // La edición durante la reproducción pausa: evita audio desfasado respecto a la nueva línea.
      this.hooks.onPlaying(false);
    }
  }

  private tick() {
    if (!this.tl) return;
    const t = this.tl.time();
    this.runtime.renderAt(t);
    this.hooks.onTime(t);
    this.onTick?.(t);
  }

  private finish() {
    this.playing = false;
    this.audio.cancel();
    this.hooks.onPlaying(false);
    this.onComplete?.();
  }

  play() {
    if (!this.tl || this.playing) return;
    if (this.tl.time() >= this._duration - 1e-3) this.tl.time(0, true);
    const p = this.hooks.getProject();
    this.audio.ensure();
    this.audio.start(this.tl.time(), this._speed, p.voice, p.clips);
    this.tl.timeScale(this._speed);
    this.playing = true;
    this.hooks.onPlaying(true);
    this.tl.play();
  }

  /** Pausa y cancela el audio programado. */
  pause() {
    if (!this.tl) return;
    this.tl.pause();
    this.audio.cancel();
    if (this.playing) {
      this.playing = false;
      this.hooks.onPlaying(false);
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  restart() {
    this.pause();
    this.seek(0);
  }

  /** Mueve el cabezal: actualiza la imagen sin disparar efectos de sonido. */
  seek(t: number) {
    if (!this.tl) return;
    if (this.playing) this.pause();
    this.tl.time(Math.min(Math.max(0, t), this._duration), true);
    this.tick();
  }

  step(frames: number) {
    this.seek(Math.round((this.time * FPS + frames)) / FPS);
  }

  setSpeed(s: number) {
    this._speed = s;
    if (!this.tl) return;
    this.tl.timeScale(s);
    if (this.playing) {
      // Resincroniza voz y efectos pendientes con la nueva velocidad.
      const p = this.hooks.getProject();
      this.audio.start(this.tl.time(), s, p.voice, p.clips);
    }
  }

  dispose() {
    this.tl?.kill();
    this.tl = null;
    this.audio.cancel();
  }
}
