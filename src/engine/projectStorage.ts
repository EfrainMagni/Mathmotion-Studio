import { actions, store } from '../store';
import type { Project } from '../types';
import { audio, engine } from './index';

const DATABASE = 'mathmotion-studio';
const PROJECTS = 'projects';
const CURRENT = 'current';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROJECTS);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('La base de datos está bloqueada por otra pestaña.'));
  });
}

function readCurrent(db: IDBDatabase): Promise<Project | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(PROJECTS).objectStore(PROJECTS).get(CURRENT);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeCurrent(db: IDBDatabase, project: Project): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROJECTS, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore(PROJECTS).put(project, CURRENT);
  });
}

export function activateProject(project: Project) {
  engine.playback?.restart();
  audio.cancel();
  audio.cancelMic();
  store.replaceProject(project);
}

export async function startProjectAutosave(): Promise<void> {
  try {
    const db = await openDatabase();
    const saved = await readCurrent(db);
    if (saved) {
      // Si el navegador actual no decodifica la voz, se conserva el archivo original.
      let audioFailed = false;
      if (saved.voice) {
        try {
          await audio.decodeVoice(saved.voice.source);
        } catch {
          audioFailed = true;
        }
      }
      activateProject(saved);
      if (audioFailed) actions.notify('error', 'Se recuperó el proyecto, pero este navegador no pudo reproducir la pista de voz.');
    }

    let previous = store.getState().project;
    let failed = false;
    store.subscribe(() => {
      const current = store.getState().project;
      if (current === previous) return;
      previous = current;
      // IndexedDB ejecuta las transacciones de escritura del mismo almacén en orden.
      void writeCurrent(db, current).then(() => {
        failed = false;
      }, () => {
        if (failed) return;
        failed = true;
        actions.notify('error', 'No se pudo autoguardar. Usa «Guardar proyecto» para conservar los cambios.');
      });
    });
  } catch {
    actions.notify('error', 'No se pudo abrir el autoguardado local. Puedes guardar el proyecto en un archivo.');
  }
}
