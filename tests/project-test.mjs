import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const executablePath = [
  process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

function wave() {
  const data = Buffer.alloc(44 + 8000);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < 4000; i++) data.writeInt16LE(Math.round(1000 * Math.sin(i / 10)), 44 + i * 2);
  return data;
}

async function savedProject(page, expectedObjects, expectedVoice) {
  await page.waitForFunction(async ({ expectedObjects, expectedVoice }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mathmotion-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('projects').objectStore('projects').get('current');
        request.onsuccess = () => resolve(
          request.result?.objects.length === expectedObjects && !!request.result?.voice === expectedVoice,
        );
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, { expectedObjects, expectedVoice });
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mathmotion-studio', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise((resolve, reject) => {
      const request = db.transaction('projects').objectStore('projects').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (project.voice) {
      const { source, ...metadata } = project.voice;
      project.voice = { ...metadata, mime: source.type, bytes: Array.from(new Uint8Array(await source.arrayBuffer())) };
    }
    return project;
  });
}

const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => {
    window.playedVoice = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer?.duration === 0.5) window.playedVoice++;
      return start.apply(this, args);
    };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const button = (name, target = page) => target.getByRole('button', { name, exact: true });
  const open = (name, buffer, target = page) => target.getByLabel('Archivo de proyecto').setInputFiles({
    name, mimeType: 'application/json', buffer,
  });
  const formula = String.raw`\begin{aligned}x^2+1 &= \frac{3}{2}\\ y &= \mathbb{R}\end{aligned}`;

  await page.goto(url);
  await button('9:16 · 1080×1920').click();
  await button('Cuadrícula').click();
  const input = page.getByRole('textbox', { name: 'Fórmula LaTeX' });
  // Esperar el resultado de la fórmula inicial evita pulsar durante la vista previa anterior.
  await button('Insertar fórmula').waitFor();
  await input.fill(formula);
  await button('Insertar fórmula').click();
  await page.getByRole('treeitem', { name: /Fórmula 1/ }).waitFor();
  await button('Escribir / Dibujar').click();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><style>.shape{fill:#123456}</style><g id="group"><path id="line" class="shape" d="M0 0 L40 0 L40 30Z"/></g></svg>';
  await page.locator('input[accept=".svg,image/svg+xml"]').setInputFiles({
    name: 'figura.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg),
  });
  await page.getByRole('treeitem', { name: /figura/ }).waitFor();
  await page.getByRole('textbox', { name: 'Relleno', exact: true }).fill('#22cc88');
  await button('Radar').click();
  const bytes = wave();
  await page.locator('input[accept^="audio/"]').setInputFiles({
    name: 'voz.wav', mimeType: 'audio/wav', buffer: bytes,
  });
  await button('Quitar pista de voz').waitFor();
  const before = await savedProject(page, 2, true);
  assert.equal(before.objects[0].tex, formula);
  assert.match(before.objects[0].markup, /<path/);
  assert.equal(before.objects[1].sourceSvg, svg);
  assert.equal(before.styles.o2.fill, '#22cc88');
  assert.deepEqual(before.clips.map((clip) => clip.type), ['draw', 'radar']);
  assert.deepEqual(before.voice.bytes, Array.from(bytes));
  assert.equal(before.format, '9:16');

  await page.reload();
  await page.getByRole('treeitem', { name: /Fórmula 1/ }).waitFor();
  await button('Quitar pista de voz').waitFor();
  assert.equal(await page.locator('[data-clip]').count(), 2);
  assert.deepEqual(await savedProject(page, 2, true), before);
  await button('Reproducir').click();
  await page.waitForFunction(() => window.playedVoice > 0);
  const downloaded = page.waitForEvent('download');
  await button('Guardar proyecto').click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'proyecto.mathmotion');
  const file = await readFile(await download.path());
  assert.equal(JSON.parse(file).project.voice.base64, bytes.toString('base64'));
  console.log('PASS autoguardado y recarga exactos con SVG, LaTeX, estilos, clips y WAV');

  const fresh = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  fresh.on('pageerror', (error) => errors.push(error.message));
  await fresh.goto(url);
  const chooser = fresh.waitForEvent('filechooser');
  await button('Abrir proyecto', fresh).click();
  await (await chooser).setFiles({ name: 'escena.json', mimeType: 'application/json', buffer: file });
  await fresh.getByRole('treeitem', { name: /Fórmula 1/ }).waitFor();
  await button('Quitar pista de voz', fresh).waitFor();
  assert.deepEqual(await savedProject(fresh, 2, true), before);
  console.log('PASS archivo .mathmotion con audio Base64 abierto como .json en un contexto nuevo');

  await open('incorrecto.mathmotion', Buffer.from('{"version":2}'), fresh);
  await fresh.getByRole('alert').filter({ hasText: 'No se pudo abrir el proyecto' }).waitFor();
  assert.deepEqual(await savedProject(fresh, 2, true), before);
  fresh.once('dialog', (dialog) => void dialog.dismiss());
  await button('Nuevo proyecto', fresh).click();
  assert.equal(await fresh.locator('[data-clip]').count(), 2);
  fresh.once('dialog', (dialog) => void dialog.accept());
  await button('Nuevo proyecto', fresh).click();
  const empty = await savedProject(fresh, 0, false);
  assert.equal(empty.format, '16:9');
  assert.deepEqual(empty.clips, []);
  await fresh.reload();
  await button('Nuevo proyecto', fresh).waitFor();
  assert.equal(await fresh.getByRole('treeitem').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS archivo inválido conserva la escena, y Nuevo proyecto se mantiene tras recargar');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
