import { mathjax } from '@mathjax/src/mjs/mathjax.js';
import { browserAdaptor } from '@mathjax/src/mjs/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js';
import { TeX } from '@mathjax/src/mjs/input/tex.js';
import { SVG } from '@mathjax/src/mjs/output/svg.js';
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/mjs/input/tex/noundefined/NoUndefinedConfiguration.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/mjs/svg.js';

// Vite empaqueta cada fuente dinámica (double-struck, calligraphic, script, fraktur, sans-serif, monospace…)
// como chunk propio; se indexan por nombre base sin extensión para resolver cualquier forma de la ruta.
const fonts = import.meta.glob('/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js');
const fontLoaders = new Map<string, () => Promise<unknown>>();
for (const [path, load] of Object.entries(fonts)) {
  fontLoaders.set(path.split('/').pop()!.replace(/\.js$/, ''), load);
}
mathjax.asyncLoad = (name: string) => {
  // MathJax pide p. ej. «[mathjax-newcm]/svg/dynamic/double-struck» (a veces sin «.js»).
  const key = name.split('/').pop()!.replace(/\.js$/, '');
  const load = fontLoaders.get(key);
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
