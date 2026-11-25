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

Requiere Node 18+ y un navegador basado en Chromium (la grabación codifica MP4/H.264 con WebCodecs + `mp4-muxer`; `MediaRecorder`/WebM queda como respaldo).

## Uso rápido

1. **Importar SVG** (panel izquierdo; «Ejemplo» carga un SVG de prueba) o escribir una fórmula LaTeX.
2. Clic en el lienzo = selecciona el elemento hijo; **Mayús+clic / Mayús+arrastrar** = objeto completo.
3. En el panel derecho, pulsa una animación (Escribir/Dibujar, Radar, Brillar, Aparecer/Deslizar, Rotar): crea un clip en el cabezal.
4. En la línea de tiempo mueve, edita numéricamente o elimina clips; arrastra el cabezal; ←/→ avanzan un fotograma (30 fps) cuando no hay un objeto seleccionado. Espacio reproduce.

## Polígonos y edición de vértices

Elige **Polígono** y arrastra desde el centro para definir el radio y la orientación. Un clic abre el diálogo de creación para fijar radio y número de lados, de 3 a 20. **Opciones de polígono** ajusta los valores para el siguiente dibujo.

Pulsa **A** o usa **Selección Directa (Vértices)** en la barra del lienzo. Selecciona un polígono, un rectángulo o un contorno SVG con anclas y arrastra un ancla. Cada arrastre se puede deshacer en un paso. Los polígonos nativos se convierten en `Polygon(...)` al exportar a Manim. Las ediciones hechas dentro de un SVG importado se trasladan como geometría SVG incrustada.

## Dibujo vectorial y Manim

Elige una herramienta en **Dibujo vectorial** y arrastra sobre el lienzo. Mantén Mayús para dibujar círculos o cuadrados. Para colocar texto, escribe en la barra lateral y haz clic o define su caja arrastrando. El inspector permite cambiar estilos, editar la punta de las flechas y alinear u ordenar los objetos.

Usa Ctrl+Z para deshacer, Ctrl+Y o Ctrl+Mayús+Z para rehacer, Ctrl+D para duplicar y Supr para eliminar. Las flechas mueven la selección 1 píxel lógico o 10 con Mayús. Sin un objeto seleccionado, izquierda y derecha recorren fotogramas. En macOS también funciona ⌘ para los atajos con Ctrl.

**Exportar código Manim (.py)** muestra el script, permite copiarlo y descarga `escena.py`. Ejecútalo con Manim Community. Las fórmulas requieren una instalación de LaTeX.

```bash
manim escena.py EscenaMathMotion
```

Las notas de exportación indican qué efectos se aproximan y qué elementos quedan fuera del script. El orden de apilamiento se ajusta entre los objetos 2D.

## Guardar y abrir proyectos

El editor autoguarda el proyecto actual y su pista de voz en IndexedDB en este navegador. Al recargar, recupera la escena automáticamente. **Nuevo proyecto** limpia el lienzo y sustituye ese autoguardado.

**Guardar proyecto** descarga un archivo `.mathmotion` que incluye la escena editable y el audio original en Base64. **Abrir proyecto** acepta archivos `.mathmotion` o `.json` generados por el editor. Guarda una copia en archivo si quieres conservar varias clases o moverlas a otro dispositivo.

## Grabar video

1. Elige calidad (**Ligera ~1,2 Mbps** o Estándar ~4 Mbps) en la barra superior.
2. Pulsa **Grabar video**. Se abre la ventana «MathMotion · vista de grabación» y el navegador pide qué compartir.
3. **Elige esa pestaña** (no ventana ni pantalla completa; si lo haces, la app aborta).
4. Se comprueba que la vista esté lista y la reproducción arranca desde 0 s a 1×. Se detiene sola al terminar (o con «Detener»).
5. Se descarga el archivo con la extensión que corresponde al formato elegido (`.mp4` con WebCodecs; `.webm` solo en el respaldo de `MediaRecorder`). La barra muestra la resolución efectiva capturada, que puede diferir del tamaño lógico del escenario.

## Pruebas

```bash
npm run test:dom
npm run test:project
npm run test:vector
npm run test:polygon
```

Pruebas en Chromium del editor 2D y del flujo de autoguardado, recarga, descarga y reapertura de un proyecto. Usa `CHROME_PATH` si el navegador está instalado en una ruta distinta de la predeterminada. La prueba vectorial verifica la sintaxis Python y puede renderizar la escena con Manim si se define `MANIM_BIN`.

## Limitaciones conocidas

Ver el informe de entrega: no se probó con el `Proyecto.svg` real ni con micrófono.
