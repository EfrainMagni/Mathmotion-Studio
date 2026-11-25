import { mathjax } from '@mathjax/src/mjs/mathjax.js';
import { browserAdaptor } from '@mathjax/src/mjs/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js';
import { TeX } from '@mathjax/src/mjs/input/tex.js';
import { SVG } from '@mathjax/src/mjs/output/svg.js';
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/mjs/input/tex/noundefined/NoUndefinedConfiguration.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/mjs/svg.js';

// Mapa explícito de las fuentes dinámicas de @mathjax/mathjax-newcm-font (4.1.3): Vite las resuelve por el
// `exports` del paquete y las empaqueta como chunks tanto en `dev` como en `build` (sin glob sobre node_modules).
// \mathbb → double-struck, \mathcal → calligraphic, \mathscr → script, \mathfrak → fraktur,
// \mathsf → sans-serif*, \mathtt → monospace*, negrita/cursiva → latin-b / latin-i / latin-bi.
const fontLoaders: Record<string, () => Promise<unknown>> = {
  'accents': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/accents.js'),
  'accents-b-i': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/accents-b-i.js'),
  'arabic': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/arabic.js'),
  'arrows': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/arrows.js'),
  'braille': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/braille.js'),
  'braille-d': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/braille-d.js'),
  'calligraphic': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/calligraphic.js'),
  'cherokee': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/cherokee.js'),
  'cyrillic': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/cyrillic.js'),
  'cyrillic-ss': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/cyrillic-ss.js'),
  'devanagari': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/devanagari.js'),
  'double-struck': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/double-struck.js'),
  'fraktur': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/fraktur.js'),
  'greek': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/greek.js'),
  'greek-ss': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/greek-ss.js'),
  'hebrew': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/hebrew.js'),
  'latin': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/latin.js'),
  'latin-b': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/latin-b.js'),
  'latin-bi': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/latin-bi.js'),
  'latin-i': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/latin-i.js'),
  'marrows': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/marrows.js'),
  'math': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/math.js'),
  'monospace': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/monospace.js'),
  'monospace-ex': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/monospace-ex.js'),
  'monospace-l': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/monospace-l.js'),
  'mshapes': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/mshapes.js'),
  'phonetics': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/phonetics.js'),
  'phonetics-ss': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/phonetics-ss.js'),
  'PUA': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/PUA.js'),
  'sans-serif': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif.js'),
  'sans-serif-b': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif-b.js'),
  'sans-serif-bi': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif-bi.js'),
  'sans-serif-ex': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif-ex.js'),
  'sans-serif-i': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif-i.js'),
  'sans-serif-r': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/sans-serif-r.js'),
  'script': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/script.js'),
  'shapes': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/shapes.js'),
  'symbols': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/symbols.js'),
  'symbols-b-i': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/symbols-b-i.js'),
  'variants': () => import('@mathjax/mathjax-newcm-font/mjs/svg/dynamic/variants.js'),
};
mathjax.asyncLoad = (name: string) => {
  // MathJax pide p. ej. «[mathjax-newcm]/svg/dynamic/double-struck» (con o sin «.js»).
  const key = name.split('/').pop()!.replace(/\.js$/, '');
  const load = Object.hasOwn(fontLoaders, key) ? fontLoaders[key] : undefined;
  if (!load) return Promise.reject(new Error(`MathJax: recurso no disponible: ${name}`));
  return load();
};

RegisterHTMLHandler(browserAdaptor());
const input = new TeX({
  packages: ['base', 'ams', 'newcommand', 'noundefined'],
  formatError(_jax: unknown, error: unknown) { throw error; },
});
const output = new SVG({ fontCache: 'none', fontData: new MathJaxNewcmFont() });
const document = mathjax.document(window.document, { InputJax: input, OutputJax: output });

export function renderFormula(tex: string): Promise<Element> {
  return mathjax.handleRetriesFor(() => document.convert(tex, { display: true }));
}
