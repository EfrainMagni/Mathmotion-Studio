import type { Project } from '../types';

/** Mensajes entre el editor y la vista limpia de grabación (misma origen, BroadcastChannel). */
export type EditorToStage =
  | { type: 'project'; token: string; project: Project }
  | { type: 'time'; t: number };

export type StageToEditor = { type: 'applied'; token: string } | { type: 'hello' };

export const channelName = (id: string) => `mathmotion-stage-${id}`;
