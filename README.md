# MathMotion Studio — Fase 1

Editor de clases de matemáticas animadas (inspirado en Manim) con vista previa instantánea en el navegador.
Formatos vertical 9:16 (1080×1920) y horizontal 16:9 (1920×1080).

## Instalación y ejecución

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit && vite build  → dist/
npm run preview    # sirve dist/
```

Requiere Node 18+ y un navegador basado en Chromium (la grabación usa `getDisplayMedia` + `MediaRecorder`).

## Uso rápido

1. **Importar SVG** (panel izquierdo; «Ejemplo» carga un SVG de prueba) o escribir una fórmula LaTeX.
2. Clic en el lienzo = selecciona el elemento hijo; **Mayús+clic / Mayús+arrastrar** = objeto completo.
3. En el panel derecho, pulsa una animación (Escribir/Dibujar, Radar, Brillar, Aparecer/Deslizar, Rotar/Orbitar): crea un clip en el cabezal.
4. En la línea de tiempo mueve, edita numéricamente o elimina clips; arrastra el cabezal; ←/→ avanzan un fotograma (30 fps); Espacio reproduce.
5. Objetos 3D: se insertan desde el panel; activa el **modo cámara** en la barra superior para orbitar.

## Grabar video

1. Elige calidad (**Ligera ~1,2 Mbps** o Estándar ~4 Mbps) en la barra superior.
2. Pulsa **Grabar video**. Se abre la ventana «MathMotion · vista de grabación» y el navegador pide qué compartir.
3. **Elige esa pestaña** (no ventana ni pantalla completa; si lo haces, la app aborta).
4. Se comprueba que la vista esté lista y la reproducción arranca desde 0 s a 1×. Se detiene sola al terminar (o con «Detener»).
5. Se descarga el archivo con la extensión que corresponde al formato elegido (`.webm` / `.mp4`). La barra muestra la resolución efectiva capturada, que puede diferir del tamaño lógico del escenario.

## Pruebas

```bash
TOOLS_PATH=<ruta a node_modules con playwright-core> node tests/dom-test.mjs
```

Pruebas de lógica en Chrome real (sanitizado SVG, transformaciones, arrastre, clips, retroceso).

## Limitaciones conocidas

Ver el informe de entrega: no se probó con el `Proyecto.svg` real, ni 3D con WebGL real, ni micrófono.
