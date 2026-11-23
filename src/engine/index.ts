import { AudioEngine } from './audio';
import type { Playback } from './playback';
import type { SceneRuntime } from './runtime';

/** Instancias compartidas del editor (se crean al montar el escenario). */
export const audio = new AudioEngine();

export const engine: { runtime: SceneRuntime | null; playback: Playback | null } = {
  runtime: null,
  playback: null,
};
