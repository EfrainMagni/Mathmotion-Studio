import { FONT_CATALOG, FONT_CATEGORIES, fontInfo, type FontCategory, type FontInfo, type Project } from '../types';

/** Variante tipográfica realmente usada por algún texto del proyecto. */
interface Used { family: string; weight: number; italic: boolean }

/**
 * Catálogo agrupado para el selector del Inspector:
 * Sans-Serif (Inter, Space Grotesk, Montserrat, Poppins, Raleway),
 * Serif (Lora, Playfair Display, Merriweather, Libre Baskerville) y
 * Caligráficas (Great Vibes, Dancing Script).
 */
export const FONT_GROUPS: { category: FontCategory; label: string; fonts: FontInfo[] }[] = FONT_CATEGORIES.map((c) => ({
  category: c.id,
  label: c.label,
  fonts: FONT_CATALOG.filter((f) => f.category === c.id),
}));

/**
 * Consulta `family=` de Google Fonts css2 con pesos explícitos (400/600/700 e itálicas donde aplique).
 * Se usan valores discretos y no rangos (`400..700`) porque algunas familias —p. ej. Poppins— no son variables.
 */
export const familyQuery = (id: string) => {
  const f = fontInfo(id);
  const name = f.id.replaceAll(' ', '+');
  if (f.weights.length === 1 && f.weights[0] === 400 && !f.italic) return name;
  if (!f.italic) return `${name}:wght@${f.weights.join(';')}`;
  const tuples = [...f.weights.map((w) => `0,${w}`), ...f.weights.map((w) => `1,${w}`)];
  return `${name}:ital,wght@${tuples.join(';')}`;
};

/** URL de la hoja de estilos con todo el catálogo; `index.html` carga exactamente esta. */
export const googleFontsHref = () =>
  `https://fonts.googleapis.com/css2?${[...FONT_CATALOG].sort((a, b) => a.id.localeCompare(b.id)).map((f) => `family=${familyQuery(f.id)}`).join('&')}&display=swap`;

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

const dataUrlCache = new Map<string, Promise<string>>();

/** Descarga un archivo de fuente como data URI; las familias variables comparten archivo entre pesos. */
const toDataUrl = (url: string) => {
  let hit = dataUrlCache.get(url);
  if (!hit) {
    hit = (async () => {
      const blob = await (await fetch(url)).blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    })();
    dataUrlCache.set(url, hit);
    hit.catch(() => dataUrlCache.delete(url));
  }
  return hit;
};

/** ¿El bloque `@font-face` cubre alguno de los pesos usados? (admite `font-weight: 400` y `400 700`). */
const coversWeight = (face: string, weights: number[]) => {
  const m = face.match(/font-weight:\s*(\d+)(?:\s+(\d+))?/);
  if (!m) return true;
  const lo = Number(m[1]);
  const hi = Number(m[2] ?? m[1]);
  return weights.some((w) => w >= lo && w <= hi);
};

async function familyCss(family: string, italic: boolean, weights: number[], subsets: string[]) {
  const key = `${family}|${italic}|${weights.join(',')}|${subsets.join(',')}`;
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
        if (!coversWeight(face, weights)) continue;
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
      const variants = used.filter((u) => u.family === family);
      const italics = new Set(variants.map((u) => u.italic));
      return [...italics].map((italic) => {
        const weights = [...new Set(variants.filter((u) => u.italic === italic).map((u) => u.weight))].sort((a, b) => a - b);
        return familyCss(family, italic, weights, subsets).catch(() => '');
      });
    }),
  );
  return parts.filter(Boolean).join('\n');
}
