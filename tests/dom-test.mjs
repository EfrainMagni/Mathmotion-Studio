// Ejecuta tests/harness.ts en un Chrome real (esbuild + playwright-core).
//   npm run test:dom
// Variables opcionales: CHROME_PATH (ejecutable de Chrome/Chromium), TOOLS_PATH (carpeta node_modules alternativa).
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const paths = [process.cwd(), resolve(here, '..'), process.env.TOOLS_PATH].filter(Boolean);
const load = (name) => require(require.resolve(name, { paths }));

const esbuild = load('esbuild');
const { chromium } = load('playwright-core');

const built = await esbuild.build({
  entryPoints: [resolve(here, 'harness.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'H',
  platform: 'browser',
  target: 'es2022',
  external: ['three'],
  logLevel: 'error',
});
const code = built.outputFiles[0].text;

const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: code });
const results = await page.evaluate(() => globalThis.H.run());
await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        → ${r.detail ?? ''}`}`);
}
if (logs.length) console.log('\nconsola del navegador:\n' + logs.join('\n'));
console.log(`\n${results.length - failed}/${results.length} pruebas correctas`);
process.exit(failed ? 1 : 0);
