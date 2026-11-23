import { mathjax } from '@mathjax/src/mjs/mathjax.js';
import { browserAdaptor } from '@mathjax/src/mjs/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/mjs/handlers/html.js';
import { TeX } from '@mathjax/src/mjs/input/tex.js';
import { SVG } from '@mathjax/src/mjs/output/svg.js';
import '@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/mjs/input/tex/noundefined/NoUndefinedConfiguration.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/mjs/svg.js';

const fonts = import.meta.glob('/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js');
mathjax.asyncLoad = (name: string) => {
  const load = fonts[`/node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/${name.split('/').pop()}`];
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
