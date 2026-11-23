import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const executablePath = [
  process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } });
let browser;

try {
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(url);

  const button = (name) => page.getByRole('button', { name, exact: true });
  const stage = page.locator('[data-stage]');
  const object = (id) => page.locator(`[data-mm-obj="${id}"]`);
  const coordinates = async (x, y) => {
    const rect = await stage.boundingBox();
    return [rect.x + x * rect.width, rect.y + y * rect.height];
  };
  async function clickPolygon(x, y, sides, radius) {
    await page.mouse.click(...await coordinates(x, y));
    const dialog = page.getByRole('dialog', { name: 'Polígono', exact: true });
    await dialog.getByLabel('Lados', { exact: true }).fill(String(sides));
    await dialog.getByLabel('Radio (px)').fill(String(radius));
    await dialog.getByRole('button', { name: 'Crear polígono', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  function points(selector) {
    return selector.evaluate((el) => el.getAttribute('points').trim().split(/\s+/).map((pair) => pair.split(',').map(Number)));
  }
  async function dragAnchor(index, dx, dy) {
    const anchor = stage.locator(`[data-vertex-index="${index}"]`);
    const rect = await anchor.boundingBox();
    assert.ok(rect, 'El vértice debe tener un control en el lienzo');
    assert.ok(Math.abs(rect.width - 8) < 1, 'El ancla mantiene el tamaño visual');
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }

  assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(20, 20, 20)');
  assert.equal(await page.locator('header').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(37, 37, 37)');
  assert.equal(await page.locator('aside').first().evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(30, 30, 30)');
  await button('Polígono').click();
  await page.mouse.click(...await coordinates(0.5, 0.48));
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await page.locator('[data-mm-obj]').count(), 0);

  await clickPolygon(0.24, 0.3, 3, 125);
  await clickPolygon(0.74, 0.28, 20, 140);
  assert.equal((await points(object('o1').locator('polygon'))).length, 3);
  assert.equal((await points(object('o2').locator('polygon'))).length, 20);
  const options = page.getByRole('button', { name: /Opciones de polígono/ });
  await options.click();
  await page.getByLabel('Lados', { exact: true }).fill('5');
  await button('Aplicar').click();
  await page.mouse.move(...await coordinates(0.54, 0.61));
  await page.mouse.down();
  await page.mouse.move(...await coordinates(0.62, 0.67), { steps: 7 });
  await page.mouse.up();
  assert.equal((await points(object('o3').locator('polygon'))).length, 5);

  const triangle = object('o1').locator('polygon');
  const original = await points(triangle);
  await page.getByRole('treeitem', { name: /Polígono/ }).first().click();
  await page.keyboard.press('a');
  assert.equal(await button('Selección Directa (Vértices)').getAttribute('aria-pressed'), 'true');
  assert.equal(await stage.locator('[data-vertex-index]').count(), 3);
  await page.getByRole('group', { name: 'Controles del lienzo' }).getByRole('button', { name: 'Acercar', exact: true }).click();
  await dragAnchor(1, 39, 21);
  const edited = await points(triangle);
  assert.notDeepEqual(edited[1], original[1]);
  assert.deepEqual([edited[0], edited[2]], [original[0], original[2]]);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await points(triangle), original);
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await points(triangle), edited);
  console.log('PASS creación de polígonos de 3, 5 y 20 lados y edición individual con Deshacer/Rehacer');

  // Los SVG lineales conservan el ID, los atributos y la relación con su grupo transformado.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><g transform="translate(850 45) scale(1.3)"><path id="trazo" d="m 0 0 h 120 v 70 l -120 -15 Z" fill="#ee9966"/><path id="curva" d="M230 50 c 40 -50 65 55 105 10" stroke="#ffcc99" stroke-width="8" fill="none"/></g></svg>';
  await page.locator('input[accept=".svg,image/svg+xml"]').setInputFiles({
    name: 'contorno.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg),
  });
  const path = object('o4').locator('path').first();
  await path.click();
  assert.equal(await stage.locator('[data-vertex-index]').count(), 4);
  await dragAnchor(2, 22, 10);
  const deformedPath = await path.getAttribute('d');
  assert.match(deformedPath, /^M 0 0 L 120 0 L /);
  assert.match(deformedPath, / L 0 55 Z$/);

  const curve = object('o4').locator('path').last();
  const curveHit = await curve.evaluate((element) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    const matrix = element.getScreenCTM();
    return [matrix.a * point.x + matrix.c * point.y + matrix.e, matrix.b * point.x + matrix.d * point.y + matrix.f];
  });
  await page.mouse.click(...curveHit);
  assert.equal(await stage.locator('[data-vertex-index]').count(), 2);
  await dragAnchor(1, -22, 13);
  const editedCurve = await curve.getAttribute('d');
  const curveNumbers = editedCurve.match(/-?[0-9.]+/g).map(Number);
  assert.deepEqual(curveNumbers.slice(0, 4), [230, 50, 270, 0]);
  assert.ok(Math.abs((curveNumbers[6] - curveNumbers[4]) - 40) < 1e-8);
  assert.ok(Math.abs((curveNumbers[7] - curveNumbers[5]) + 45) < 1e-8);

  const downloading = page.waitForEvent('download');
  await button('Guardar proyecto').click();
  const bytes = await readFile(await (await downloading).path());
  const saved = JSON.parse(bytes).project;
  assert.deepEqual(saved.objects[0].vector.vertices.map(({ x, y }) => [x, y]), edited);
  assert.ok(Object.values(saved.styles).some((style) => style.vertices?.length === 4));
  await page.reload();
  assert.deepEqual(await points(triangle), edited);
  assert.equal(await path.getAttribute('d'), deformedPath);
  assert.equal(await curve.getAttribute('d'), editedCurve);

  const fresh = await browser.newPage();
  await fresh.goto(url);
  await fresh.getByLabel('Archivo de proyecto').setInputFiles({
    name: 'poligonos.mathmotion', mimeType: 'application/json', buffer: bytes,
  });
  const restored = fresh.locator('[data-mm-obj="o1"] polygon');
  await restored.waitFor({ state: 'attached' });
  assert.deepEqual(await points(restored), edited);
  assert.equal(await fresh.locator('[data-mm-obj="o4"] path').first().getAttribute('d'), deformedPath);
  await fresh.getByRole('button', { name: 'Exportar código Manim (.py)', exact: true }).click();
  const code = await fresh.getByLabel('Vista previa del código Python').inputValue();
  const polygons = [...code.matchAll(/^\s+o[123] = Polygon\((.*)\)$/gm)];
  assert.deepEqual(polygons.map(([, value]) => (value.match(/np\.array/g) ?? []).length), [3, 20, 5]);
  const [x, y] = edited[1];
  const unit = 8 / 1080;
  const clean = (n) => Number(n.toFixed(7)).toString();
  assert.ok(polygons[0][1].includes(`np.array([${clean((x - 125) * unit)}, ${clean((125 - y) * unit)}, 0.0])`));
  assert.ok(code.includes(deformedPath));
  assert.ok(code.includes(editedCurve));
  assert.deepEqual(errors, []);
  console.log('PASS contornos SVG, persistencia de vértices en IndexedDB y .mathmotion, y coordenadas exportadas a Manim');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
