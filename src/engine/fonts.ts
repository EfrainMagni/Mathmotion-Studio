import { FONT_CATALOG, fontInfo, type Project } from '../types';

/** Variante tipográfica realmente usada por algún texto del proyecto. */
interface Used { family: string; weight: number; italic: boolean }

const familyQuery = (id: string) => {
  const f = fontInfo(id);
  const name = f.id.replaceAll(' ', '+');
  if (f.id === 'Great Vibes') return name;
  return f.italic ? `${name}:ital,wght@0,400..700;1,400..700` : `${name}:wght@400..700`;
};

export function usedFonts(project: Project): { used: Used[]; text: string } {
  const used: Used[] = [];
  let text = '';
  for (const o of project.objects) {
    if (o.vector?.tool !== 'text' || !o.vector.textStyle) continue;
    const style = o.vector.textStyle;
    text += o.vector.text ?? '';
    if (!used.some((u) => u.family === style.fontFamily && u.weight === style.fontWeight && u.italic === style.italic)) {
      used.push({ family: style.fontFamily, weight: style.fontWeight, italic: style.italic });
    }
  }
  return { used, text };
}

/** Descarga (si hace falta) las tipografías indicadas y espera a que el documento las tenga listas. */
export async function loadFonts(used: Used[], sample = 'Aa') {
  try {
    await Promise.all(used.map((u) => document.fonts.load(`${u.italic ? 'italic ' : ''}${u.weight} 32px '${u.family}'`, sample)));
    await document.fonts.ready;
  } catch {
    /* sin red: se usa la fuente de respaldo */
  }
}

export const preloadFont = (family: string, weight = 400, italic = false) => loadFonts([{ family, weight, italic }]);

const cssCache = new Map<string, Promise<string>>();

const toDataUrl = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

async function familyCss(family: string, italic: boolean, subsets: string[]) {
  const key = `${family}|${italic}|${subsets.join(',')}`;
  let hit = cssCache.get(key);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(`https://fonts.googleapis.com/css2?family=${familyQuery(family)}&display=block`);
      const css = await res.text();
      const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)];
      const out: string[] = [];
      for (const [, subset, face] of blocks) {
        if (!subsets.includes(subset)) continue;
        const isItalic = /font-style:\s*italic/.test(face);
        if (isItalic !== italic) continue;
        const url = face.match(/url\((https:[^)]+)\)/)?.[1];
        if (!url) continue;
        out.push(face.replace(url, await toDataUrl(url)));
      }
      return out.join('\n');
    })();
    cssCache.set(key, hit);
    hit.catch(() => cssCache.delete(key));
  }
  return hit;
}

/**
 * `@font-face` con las fuentes incrustadas (data URI). Un SVG cargado como imagen no puede usar las
 * tipografías de la página ni descargar recursos externos, así que la captura de vídeo las lleva dentro.
 */
export async function embeddedFontCss(project: Project): Promise<string> {
  const { used, text } = usedFonts(project);
  if (!used.length) return '';
  const subsets = ['latin'];
  if (/[Ā-ɏ]/.test(text)) subsets.push('latin-ext');
  if (/[Ͱ-Ͽ]/.test(text)) subsets.push('greek');
  const families = [...new Set(used.map((u) => u.family))].filter((f) => FONT_CATALOG.some((c) => c.id === f));
  const parts = await Promise.all(
    families.flatMap((family) => {
      const italics = new Set(used.filter((u) => u.family === family).map((u) => u.italic));
      return [...italics].map((italic) => familyCss(family, italic, subsets).catch(() => ''));
    }),
  );
  return parts.filter(Boolean).join('\n');
}
