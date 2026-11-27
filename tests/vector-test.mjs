import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { preview } from 'vite';

const bundled = await build({
  stdin: { contents: 'export { History } from "./src/engine/history";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { History } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const history = new History();
const drag = Symbol();
history.record('inicio', drag);
history.record('movimiento intermedio', drag);
assert.equal(history.undo('fin'), 'inicio');
assert.equal(history.redo('inicio'), 'fin');
assert.equal(history.undo('fin'), 'inicio');
history.record('inicio');
assert.equal(history.redo('nueva edición'), undefined);
console.log('PASS historial agrupa un gesto y descarta Rehacer tras una nueva edición');

const executablePath = [
  process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } });
let browser;
let scratch;
try {
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1120 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const button = (name) => page.getByRole('button', { name, exact: true });
  const box = () => page.locator('[data-stage]').boundingBox();
  const object = (id) => page.locator(`[data-mm-obj="${id}"]`);
  const tree = (name) => page.getByRole('treeitem', { name });
  const transform = (id) => object(id).evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return [matrix.e, matrix.f];
  });
  async function draw(tool, x1, y1, x2, y2) {
    await button(tool).click();
    const { x, y, width, height } = await box();
    await page.mouse.move(x + x1 * width, y + y1 * height);
    await page.mouse.down();
    await page.mouse.move(x + x2 * width, y + y2 * height, { steps: 7 });
    await page.mouse.up();
  }

  await page.goto(url);
  await draw('Rectángulo', 0.1, 0.1, 0.3, 0.28);
  await object('o1').waitFor();
  const beforeDrag = await transform('o1');
  await button('Selección').click();
  const bounds = await object('o1').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 10, { steps: 9 });
  await page.mouse.up();
  const afterDrag = await transform('o1');
  assert.notDeepEqual(afterDrag, beforeDrag);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await transform('o1'), beforeDrag);
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await transform('o1'), afterDrag);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const nudged = await transform('o1');
  assert.ok(Math.abs(nudged[0] - afterDrag[0] - 1) < 0.001);
  assert.ok(Math.abs(nudged[1] - afterDrag[1] - 10) < 0.001);
  await page.keyboard.press('Control+d');
  await tree(/Rectángulo \(copia\)/).waitFor();
  await page.keyboard.press('Delete');
  assert.equal(await tree(/copia/).count(), 0);
  await page.keyboard.press('Control+z');
  await tree(/copia/).waitFor();
  await page.keyboard.press('Control+y');
  assert.equal(await tree(/copia/).count(), 0);

  await tree(/Rectángulo/).click();
  await button('Centrar horizontal').click();
  await button('Centrar vertical').click();
  const centered = await object('o1').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return [matrix.e + parseFloat(element.style.width) / 2, matrix.f + parseFloat(element.style.height) / 2];
  });
  assert.ok(Math.abs(centered[0] - 960) < 0.001);
  assert.ok(Math.abs(centered[1] - 540) < 0.001);
  await button('Create / Write').click();
  console.log('PASS creación, gestos, Deshacer/Rehacer, duplicación, Suprimir y alineación');

  await draw('Círculo / Elipse', 0.62, 0.12, 0.84, 0.34);
  await button('FadeIn').click();
  await draw('Línea', 0.66, 0.65, 0.9, 0.65);
  await draw('Flecha vectorial', 0.28, 0.72, 0.12, 0.48);
  await page.getByLabel('Punta de flecha').selectOption('both');
  await page.getByLabel('Grosor', { exact: true }).fill('8');
  await page.getByLabel('Estilo de línea').selectOption('dotted');
  await page.getByLabel('Opacidad (%)').fill('55');
  await page.getByRole('textbox', { name: 'Trazo', exact: true }).fill('#aa4411');
  await button('Enviar atrás').click();
  await button('Rotar', { exact: true }).click();
  await button('Texto libre').click();
  await page.getByLabel('Texto para dibujar').fill('Texto «libre»: <x> y "comillas"');
  await draw('Texto libre', 0.52, 0.74, 0.85, 0.84);
  await button('Create / Write').click();
  assert.equal(await object('o6').locator('text').textContent(), 'Texto «libre»: <x> y "comillas"');
  await page.getByRole('textbox', { name: 'Fórmula LaTeX' }).fill('x^2+1');
  await button('Insertar fórmula').click();
  await button('Create / Write').click();
  await button('Ejemplo').click();
  await page.getByLabel('Grosor', { exact: true }).fill('5');
  await page.getByLabel('Estilo de línea').selectOption('dotted');

  await page.reload();
  await tree(/Flecha vectorial/).waitFor();
  const arrow = object('o5');
  await assert.doesNotReject(() => arrow.locator('line[marker-start]').waitFor({ state: 'attached' }));
  assert.equal(await arrow.evaluate((element) => element.style.opacity), '0.55');
  assert.notEqual(await arrow.locator('line').evaluate((line) => getComputedStyle(line).strokeDasharray), 'none');
  assert.equal(await page.locator('[data-mm-obj]').first().getAttribute('data-mm-obj'), 'o5');

  await button('Exportar código Manim (.py)').click();
  const modal = page.getByRole('dialog', { name: 'Exportar código Manim' });
  await modal.waitFor();
  const code = await modal.getByLabel('Vista previa del código Python').inputValue();
  for (const pattern of [
    /class EscenaMathMotion\(Scene\)/, /Rectangle\(width=/, /Ellipse\(width=/, /Line\(np.array/,
    /add_tip\(at_start=True/, /DashedVMobject/, /set_stroke\(color="#aa4411", width=8/,
    /Text\("Texto «libre»/, /MathTex\("x\^2\+1"\)/, /embedded_svg\("/,
    /lambda: Create\(o1/, /lambda: FadeIn/, /lambda: Rotate/, /lambda: Write/,
    /config.pixel_width = 1920/, /config.pixel_height = 1080/,
  ]) assert.match(code, pattern);
  await modal.getByRole('button', { name: 'Copiar código' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
  const downloading = page.waitForEvent('download');
  await modal.getByRole('button', { name: 'Descargar escena.py' }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'escena.py');
  assert.equal(await readFile(await download.path(), 'utf8'), code);
  const parsed = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  await modal.getByRole('button', { name: 'Cerrar' }).click();

  const projectDownload = page.waitForEvent('download');
  await button('Guardar proyecto').click();
  const projectBytes = await readFile(await (await projectDownload).path());
  const fresh = await browser.newPage();
  await fresh.goto(url);
  await fresh.getByLabel('Archivo de proyecto').setInputFiles({
    name: 'vectores.mathmotion', mimeType: 'application/json', buffer: projectBytes,
  });
  await fresh.getByRole('treeitem', { name: /Flecha vectorial/ }).waitFor();
  await fresh.getByRole('button', { name: 'Exportar código Manim (.py)', exact: true }).click();
  assert.equal(await fresh.getByLabel('Vista previa del código Python').inputValue(), code);

  assert.deepEqual(errors, []);
  console.log('PASS persistencia vectorial y exportación Manim con vista previa, copia, descarga y sintaxis Python');

  if (process.env.MANIM_BIN) {
    scratch = await mkdtemp(join(tmpdir(), 'mathmotion-manim-'));
    const script = join(scratch, 'escena.py');
    await writeFile(script, code);
    const render = spawnSync(process.env.MANIM_BIN, ['-ql', '--disable_caching', script, 'EscenaMathMotion'], {
      cwd: scratch, encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000,
    });
    assert.equal(render.status, 0, render.stderr || render.error?.message || render.stdout);
    console.log('PASS render de la escena exportada con Manim Community');
  }
} finally {
  await browser?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await new Promise((resolve) => server.httpServer.close(resolve));
}
