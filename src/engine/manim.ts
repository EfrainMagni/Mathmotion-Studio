import { BACKGROUND_COLOR, STAGE_SIZES, sceneDuration, type Clip, type NodeStyle, type Obj2D, type Project, type SceneObject } from '../types';
import { svgWithVertices } from './vertices';
import { normalizePlane } from './cartesianPlane';
import { clipGlyphs, directedGlyphClips, directedTargets, entranceScope, findGlyphElements, glyphRuns } from './glyphs';
import { VECTOR_FILL, VECTOR_STROKE, VECTOR_STROKE_WIDTH } from './vector';

const n = (value: number) => Number(value.toFixed(7)).toString();
const quoted = (value: string) => JSON.stringify(value);
const point = (x: number, y: number) => `np.array([${n(x)}, ${n(y)}, 0.0])`;
const FRAME_HEIGHT = 8;

function stagePoint(object: Obj2D, width: number, height: number) {
  const unit = FRAME_HEIGHT / height;
  return point((object.x - width / 2) * unit, (height / 2 - object.y) * unit);
}

function cssColor(value: string | undefined) {
  if (!value || value === 'none' || value === 'currentColor' || value === 'transparent') return undefined;
  if (/^#[\da-f]{3,8}$/i.test(value)) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) return '#' + [...hex.slice(0, 3)].map((char) => char + char).join('');
    if (hex.length === 6 || hex.length === 8) return '#' + hex.slice(0, 6);
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:[, /]+[\d.]+)?\s*\)$/);
  if (rgb) return '#' + rgb.slice(1, 4).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('');
  return undefined;
}

function vectorConstructor(object: Obj2D, unit: number) {
  const vector = object.vector!;
  const w = object.bw * unit;
  const h = object.bh * unit;
  if (vector.tool === 'polygon') {
    const vertices = vector.vertices!.map(({ x, y }) => point((x - object.bw / 2) * unit, (object.bh / 2 - y) * unit));
    return `Polygon(${vertices.join(', ')})`;
  }
  if (vector.tool === 'rectangle') return `Rectangle(width=${n(w)}, height=${n(h)})`;
  if (vector.tool === 'ellipse') {
    return Math.abs(w - h) < 0.00001 ? `Circle(radius=${n(w / 2)})` : `Ellipse(width=${n(w)}, height=${n(h)})`;
  }
  if (vector.tool === 'text') return `Text(${quoted(vector.text?.trim() ? vector.text : ' ')})`;
  const dx = object.bw <= 1 ? 0 : (vector.reverseX ? -w : w) / 2;
  const dy = object.bh <= 1 ? 0 : (vector.reverseY ? h : -h) / 2;
  return `Line(${point(-dx, -dy)}, ${point(dx, dy)})`;
}

/**
 * Indexación de glifos en Manim. Si la fórmula es «simple» (un glifo por carácter) se construye
 * con una parte de MathTex por glifo: `eq[5]` es el glifo 5 y TransformMatchingTex empareja símbolos
 * iguales. En otro caso es un único MathTex y los glifos cuelgan de `eq[0]` (índices aproximados).
 */
interface TexInfo {
  tokens: string[] | null;
  count: number;
}

const SIMPLE_TEX = /^[A-Za-z0-9+\-=<>()[\]|,.;:!/*\s]+$/;

function texInfo(object: Obj2D): TexInfo {
  let count = 0;
  if (typeof DOMParser !== 'undefined') {
    try {
      count = findGlyphElements(new DOMParser().parseFromString(object.sourceSvg, 'image/svg+xml').documentElement).length;
    } catch {
      count = 0;
    }
  }
  const tex = object.tex ?? '';
  if (SIMPLE_TEX.test(tex)) {
    const tokens = [...tex.replace(/\s+/g, '')];
    if (tokens.length === count) return { tokens, count };
  }
  return { tokens: null, count };
}

function glyphGroup(name: string, info: TexInfo, indices: number[]): string | null {
  const base = info.tokens ? name : `${name}[0]`;
  const refs = glyphRuns(indices.filter((index) => index < info.count))
    .map(([a, b]) => (a === b ? `${base}[${a}]` : `${base}[${a}:${b + 1}]`));
  if (!refs.length) return null;
  return refs.length === 1 ? refs[0] : `VGroup(${refs.join(', ')})`;
}

/** Expresión Python del alcance de un clip: toda la ecuación, un término o glifos sueltos. */
function selectionCode(object: Obj2D, params: Clip['parameters'], info: TexInfo): string {
  const indices = clipGlyphs(object, params);
  if (!indices) return object.id;
  const term = typeof params.term === 'string' ? object.terms?.find((entry) => entry.id === params.term) : undefined;
  if (term && glyphGroup(object.id, info, term.glyphs)) return `${object.id}_${term.id}`;
  return glyphGroup(object.id, info, indices) ?? object.id;
}

/** Estilos por glifo y términos con nombre, como `eq[0:2].set_color(...)`. */
function glyphCommands(object: Obj2D, info: TexInfo) {
  const commands: string[] = [];
  const groups = new Map<string, { indices: number[]; style: NonNullable<Obj2D['glyphStyles']>[string] }>();
  for (const [key, style] of Object.entries(object.glyphStyles ?? {})) {
    const id = JSON.stringify(style);
    const group = groups.get(id) ?? { indices: [], style };
    group.indices.push(Number(key));
    groups.set(id, group);
  }
  for (const { indices, style } of groups.values()) {
    const ref = glyphGroup(object.id, info, indices);
    if (!ref) continue;
    const color = cssColor(style.color);
    if (color) commands.push(`${ref}.set_color(${quoted(color)})`);
    if (style.opacity !== undefined && style.opacity !== 1) commands.push(`${ref}.set_opacity(${n(style.opacity)})`);
    if (style.scale !== undefined && style.scale !== 1) commands.push(`${ref}.scale(${n(style.scale)})`);
  }
  for (const term of object.terms ?? []) {
    const ref = glyphGroup(object.id, info, term.glyphs);
    if (ref) commands.push(`${object.id}_${term.id} = ${ref}  # término ${quoted(term.name.replace(/[\r\n]+/g, ' '))}`);
  }
  return commands;
}

/** Plano cartesiano → `NumberPlane` de Manim (cuadrícula, subcuadrícula, ejes con punta Stealth, coordenadas). */
function planeCode(object: Obj2D, style: NodeStyle, width: number, height: number) {
  const plane = normalizePlane(object.plane);
  const name = object.id;
  const unit = FRAME_HEIGHT / height;
  const color = (value: string) => quoted(cssColor(value) ?? '#ffffff');
  const tip = Math.min(9 + 3.2 * plane.axisWidth, Math.min(plane.width, plane.height) / 4) * object.scale * unit;
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.min(plane.xStep, plane.yStep)) - 1e-9)));
  const axis = [
    `"color": ${color(plane.axisColor)}`, `"stroke_width": ${n(plane.axisWidth)}`,
    `"include_tip": ${plane.showAxes && plane.arrowTips !== 'none' ? 'True' : 'False'}`,
    `"tip_shape": StealthTip`, `"tip_width": ${n(tip * 0.76)}`, `"tip_height": ${n(tip)}`,
    `"include_ticks": ${plane.showTicks ? 'True' : 'False'}`, `"tick_size": ${n((plane.tickLength / 2) * object.scale * unit)}`,
    `"font_size": ${n(Math.max(4, plane.numberSize * object.scale * unit * 100))}`,
    `"decimal_number_config": {"num_decimal_places": ${decimals}, "color": ${color(plane.numberColor)}}`,
  ];
  const mainOpacity = plane.showGrid ? plane.gridOpacity : 0;
  const commands = [
    `${name} = NumberPlane(`,
    `    x_range=[${n(plane.xMin)}, ${n(plane.xMax)}, ${n(plane.xStep)}], y_range=[${n(plane.yMin)}, ${n(plane.yMax)}, ${n(plane.yStep)}],`,
    `    x_length=${n(plane.width * object.scale * unit)}, y_length=${n(plane.height * object.scale * unit)},`,
    `    background_line_style={"stroke_color": ${color(plane.gridColor)}, "stroke_width": ${n(plane.gridWidth)}, "stroke_opacity": ${n(mainOpacity)}},`,
    `    faded_line_style={"stroke_color": ${color(plane.subGridColor)}, "stroke_width": ${n(plane.subGridWidth)}, "stroke_opacity": ${n(plane.showSubGrid ? plane.subGridOpacity : 0)}},`,
    `    faded_line_ratio=${plane.showSubGrid ? plane.subdivisions : 1},`,
    `    axis_config={${axis.join(', ')}},`,
    ')',
  ];
  if (!plane.showAxes) commands.push(`${name}.x_axis.set_opacity(0)`, `${name}.y_axis.set_opacity(0)`);
  else {
    if (plane.arrowTips === 'both') commands.push(`${name}.x_axis.add_tip(tip_shape=StealthTip, at_start=True, tip_length=${n(tip)})`, `${name}.y_axis.add_tip(tip_shape=StealthTip, at_start=True, tip_length=${n(tip)})`);
    if (plane.showNumbers) commands.push(`${name}.add_coordinates()`);
    if (plane.showNumbers && plane.showOriginZero && plane.xMin <= 0 && plane.xMax >= 0 && plane.yMin <= 0 && plane.yMax >= 0) {
      const size = n(Math.max(4, plane.numberSize * object.scale * unit * 100));
      commands.push(`${name}.add(MathTex("0", font_size=${size}, color=${color(plane.numberColor)}).next_to(${name}.c2p(0, 0), DL, buff=${n(0.35 * plane.numberSize * object.scale * unit)}))`);
    }
    if (plane.showAxisLabels && (plane.xLabel.trim() || plane.yLabel.trim())) {
      const size = n(Math.max(4, plane.numberSize * 1.5 * object.scale * unit * 100));
      const label = (text: string) => (text.trim() ? `MathTex(${quoted(text.trim())}, font_size=${size}, color=${color(plane.axisColor)})` : 'VGroup()');
      commands.push(`${name}.add(${name}.get_axis_labels(x_label=${label(plane.xLabel)}, y_label=${label(plane.yLabel)}))`);
    }
  }
  const opacity = style.opacity ?? 1;
  if (opacity !== 1) commands.push(`${name}.fade(${n(1 - opacity)})`);
  if (object.rotation) commands.push(`${name}.rotate(${n(-object.rotation)} * DEGREES, axis=OUT)`);
  commands.push(`${name}.move_to(${stagePoint(object, width, height)})`);
  return commands;
}

function objectCode(object: SceneObject, style: NodeStyle, width: number, height: number, styles: Project['styles']) {
  if (object.plane) return planeCode(object, style, width, height);
  const name = object.id;
  const unit = FRAME_HEIGHT / height;
  const info = object.kind === 'formula' && object.tex && !object.vector ? texInfo(object) : null;
  let constructor: string;
  if (object.vector) constructor = vectorConstructor(object, unit);
  else if (object.kind === 'formula' && object.tex) constructor = `MathTex(${info?.tokens ? info.tokens.map(quoted).join(', ') : quoted(object.tex)})`;
  else constructor = `embedded_svg(${quoted(svgWithVertices(object.markup, object.id, styles))})`;

  const commands = [`${name} = ${constructor}`];
  const vector = object.vector;
  const linear = vector?.tool === 'line' || vector?.tool === 'arrow';
  if (vector?.tool === 'text' || !vector) {
    commands.push(`if ${name}.width > 0: ${name}.scale_to_fit_width(${n(object.bw * unit)})`);
    if (vector?.tool === 'text') commands.push(`if ${name}.height > 0: ${name}.stretch_to_fit_height(${n(object.bh * unit)})`);
  }

  const defaultFormulaColor = object.kind === 'formula'
    ? object.markup.match(/style="[^"]*\bcolor:(#[\da-f]{6})/i)?.[1] : undefined;
  const fill = cssColor(style.fill) ?? (vector && !linear ? VECTOR_FILL : defaultFormulaColor);
  const stroke = cssColor(style.stroke) ?? (linear ? VECTOR_STROKE : undefined);
  const hiddenFill = style.fill === 'none' || style.fill === 'transparent';
  const hiddenStroke = style.stroke === 'none' || style.stroke === 'transparent';
  const opacity = style.opacity ?? 1;
  if (fill || hiddenFill) {
    commands.push(`${name}.set_fill(${fill ? `color=${quoted(fill)}, ` : ''}opacity=${hiddenFill ? 0 : 1})`);
  }
  const strokeWidth = style.strokeWidth ?? (linear ? VECTOR_STROKE_WIDTH : vector ? 0 : undefined);
  if (stroke || hiddenStroke || strokeWidth !== undefined) {
    const args = [stroke && `color=${quoted(stroke)}`, strokeWidth !== undefined && `width=${n(strokeWidth)}`,
      `opacity=${hiddenStroke ? 0 : 1}`].filter(Boolean);
    commands.push(`${name}.set_stroke(${args.join(', ')})`);
  }
  if (vector?.tool === 'arrow' && vector.tip !== 'none') {
    const tip = vector.tip === 'open' ? 'ArrowTriangleTip' : 'ArrowTriangleFilledTip';
    const tipLength = n(Math.min(0.16, 0.25 * Math.hypot(object.bw, object.bh) * unit));
    commands.push(`${name}.add_tip(tip_shape=${tip}, tip_length=${tipLength})`);
    if (vector.tip === 'both') commands.push(`${name}.add_tip(at_start=True, tip_length=${tipLength})`);
  }
  if (style.lineStyle === 'dotted' && !hiddenStroke && (strokeWidth ?? 1) > 0) {
    const count = Math.max(2, Math.min(180, Math.round(object.bw / ((strokeWidth ?? 4) * 2.5))));
    const outline = `DashedVMobject(${name}.copy().set_fill(opacity=0), num_dashes=${count}, dashed_ratio=0.18)`;
    if (vector?.tool === 'arrow' && vector.tip !== 'none') {
      commands.push(`${name} = VGroup(${outline}, *${name}.get_tips())`);
    } else if (!linear) {
      commands.push(`${name} = VGroup(${name}.copy().set_stroke(width=0), ${outline})`);
    } else {
      commands.push(`${name} = ${outline}`);
    }
  }
  if (opacity !== 1) commands.push(`${name}.fade(${n(1 - opacity)})`);
  const pivot = vector?.tool === 'polygon' ? ', about_point=ORIGIN' : '';
  if (object.scale !== 1) commands.push(`${name}.scale(${n(object.scale)}${pivot})`);
  if (object.rotation) commands.push(`${name}.rotate(${n(-object.rotation)} * DEGREES, axis=OUT${pivot})`);
  commands.push(`${name}.${pivot ? 'shift' : 'move_to'}(${stagePoint(object, width, height)})`);
  if (info) commands.push(...glyphCommands(object, info));
  return commands;
}

function animation(clip: Clip, object: SceneObject, width: number, height: number, scoped?: string) {
  const unit = FRAME_HEIGHT / height;
  const id = scoped ?? object.id;
  const params = clip.parameters;
  const duration = `run_time=${n(clip.duration)}`;
  switch (clip.type) {
    case 'draw': {
      const write = (object.kind === 'formula' || object.vector?.tool === 'text');
      const lag = write && typeof params.lagRatio === 'number' && params.lagRatio >= 0 ? `, lag_ratio=${n(params.lagRatio)}` : '';
      if (object.plane) return `Create(${id}, lag_ratio=0.02, ${duration})`;
      return `${write ? 'Write' : 'Create'}(${id}${lag}, ${duration})`;
    }
    case 'appear': {
      const direction: Record<string, string> = { left: 'RIGHT', right: 'LEFT', up: 'DOWN', down: 'UP' };
      const offset = direction[String(params.direction)];
      const distance = typeof params.distance === 'number' ? params.distance : 120;
      return `FadeIn(${id}${offset ? `, shift=${offset} * ${n(distance * unit)}` : ''}, ${duration})`;
    }
    case 'rotate': {
      const degrees = params.mode === 'spin' && typeof params.speed === 'number'
        ? params.speed * clip.duration : typeof params.angle === 'number' ? params.angle : 360;
      const pivot = object.vector?.tool === 'polygon'
        ? `, about_point=${stagePoint(object, width, height)}` : '';
      return `Rotate(${id}, angle=${n(-degrees)} * DEGREES, axis=OUT${pivot}, ${duration})`;
    }
    case 'glow':
    case 'radar':
      return `Indicate(${id}, color=${quoted(cssColor(String(params.color)) ?? '#fde047')}, ${duration})`;
    default:
      return undefined;
  }
}

const EQUATION_CLIPS = new Set<Clip['type']>(['indicate', 'circumscribe', 'focus', 'transform', 'transformMatch']);

interface EquationEvent {
  code: string;
  /** Clave de serialización: los clips sobre el mismo alcance se encadenan. */
  key: string;
  overlay: boolean;
  /** «Mantener ecuación origen»: la copia se anima y el destino se restaura al terminar. */
  keep?: boolean;
  /** Mobjects destino que solo aparecen cuando empieza la transformación. */
  reveal: string[];
}

/** Énfasis y transformaciones de ecuaciones (Indicate, Circumscribe, FocusOn, Transform…). */
function equationAnimation(
  clip: Clip, object: Obj2D, project: Project, info: (object: Obj2D) => TexInfo, notes: Set<string>, unit: number,
): EquationEvent | null {
  const params = clip.parameters;
  const duration = `run_time=${n(clip.duration)}`;
  const own = object.kind === 'formula' && !object.vector ? info(object) : { tokens: null, count: 0 };
  const selection = selectionCode(object, params, own);
  if (own.count && !own.tokens && clipGlyphs(object, params)) notes.add('Ecuaciones complejas: los índices de glifos pueden diferir de los de MathTex (verifica con eq[0][i]).');
  const key = `${object.id}|${selection}`;
  const color = cssColor(typeof params.color === 'string' ? params.color : undefined) ?? '#ffff00';
  const destination = typeof params.to === 'string' && params.to !== object.id ? project.objects.find((entry) => entry.id === params.to) : undefined;
  const target = destination;

  switch (clip.type) {
    case 'indicate':
      return { key, overlay: false, reveal: [], code: `Indicate(${selection}, scale_factor=${n(typeof params.scale === 'number' ? params.scale : 1.3)}, color=${quoted(color)}, ${duration})` };
    case 'circumscribe':
      return { key, overlay: true, reveal: [], code: `Circumscribe(${selection}, color=${quoted(color)}, ${duration})` };
    case 'focus':
      return {
        key, overlay: true, reveal: [],
        code: `FocusOn(${selection}, color=${quoted(cssColor(typeof params.color === 'string' ? params.color : undefined) ?? '#888888')}, opacity=${n(typeof params.opacity === 'number' ? params.opacity : 0.2)}, ${duration})`,
      };
    case 'transform': {
      if (target) {
        const targetInfo = target.kind === 'formula' && !target.vector ? info(target) : { tokens: null, count: 0 };
        const termId = typeof params.toTerm === 'string' ? params.toTerm : '';
        const term = termId ? target.terms?.find((entry) => entry.id === termId) : undefined;
        const destCode = term && glyphGroup(target.id, targetInfo, term.glyphs) ? `${target.id}_${term.id}` : target.id;
        const type = params.replace ? 'ReplacementTransform' : 'Transform';
        // «Mantener ecuación origen»: se anima una copia y el origen permanece en escena.
        const keep = params.keep === true;
        return { key, overlay: keep, keep, reveal: [destCode], code: `${type}(${selection}${keep ? '.copy()' : ''}, ${destCode}, ${duration})` };
      }
      const chain: string[] = [];
      const factor = typeof params.scale === 'number' ? params.scale : 1;
      const turn = typeof params.rotation === 'number' ? params.rotation : 0;
      const dx = typeof params.dx === 'number' ? params.dx : 0;
      const dy = typeof params.dy === 'number' ? params.dy : 0;
      const opacity = typeof params.opacity === 'number' ? params.opacity : 1;
      const tint = cssColor(typeof params.color === 'string' ? params.color : undefined);
      if (factor !== 1) chain.push(`.scale(${n(factor)})`);
      if (turn) chain.push(`.rotate(${n(-turn)} * DEGREES)`);
      if (dx || dy) chain.push(`.shift(${point(dx * unit, -dy * unit)})`);
      if (tint) chain.push(`.set_color(${quoted(tint)})`);
      if (opacity !== 1) chain.push(`.set_opacity(${n(opacity)})`);
      return { key, overlay: false, reveal: [], code: `Transform(${selection}, ${selection}.copy()${chain.join('')}, ${duration})` };
    }
    case 'transformMatch': {
      if (!target || target.kind !== 'formula' || target.vector || object.kind !== 'formula' || !object.tex || !target.tex) return null;
      const exact = !!own.tokens && !!info(target).tokens;
      if (!exact) notes.add('TransformMatchingTex usa TransformMatchingShapes en ecuaciones complejas (empareja por forma de glifo).');
      const keep = params.keep === true;
      return {
        key: object.id, overlay: keep, keep, reveal: [target.id],
        code: `${exact ? 'TransformMatchingTex' : 'TransformMatchingShapes'}(${object.id}${keep ? '.copy()' : ''}, ${target.id}, ${duration})`,
      };
    }
    default:
      return null;
  }
}

const SVG_HELPER = `def embedded_svg(markup):
    with TemporaryDirectory() as folder:
        path = Path(folder) / "shape.svg"
        path.write_text(markup, encoding="utf-8")
        return SVGMobject(str(path), use_svg_cache=False)
`;

const TIMELINE_HELPER = `def play_timeline(scene, objects, events, duration):
    # Los eventos de distintos objetos avanzan en paralelo.
    hidden = {}
    seen = set()
    for start, length, mob, entrance, build, opts in events:
        if mob not in seen and entrance:
            hidden[mob] = mob.copy()
            mob.set_opacity(0)
        seen.add(mob)
        for other in opts.get("reveal", []):
            # Destino de una transformación: solo aparece cuando esta empieza.
            if other not in hidden:
                hidden[other] = other.copy()
                other.set_opacity(0)
    active = []
    cursor = 0

    def finish_until(time):
        remaining = []
        for end, start, animation, opts in active:
            if end <= time + 1e-9:
                animation.finish()
                if opts.get("overlay"):
                    scene.remove(animation.mobject)
                for other, final in opts.get("finals", []):
                    # Mantener ecuación origen: la copia desaparece y el destino queda visible.
                    other.become(final)
            else:
                remaining.append((end, start, animation, opts))
        active[:] = remaining

    def update(_group, alpha):
        nonlocal cursor
        time = alpha * duration
        while cursor < len(events) and events[cursor][0] <= time + 1e-9:
            start, length, mob, entrance, build, opts = events[cursor]
            finish_until(start)
            if mob in hidden:
                mob.become(hidden.pop(mob))
            for other in opts.get("reveal", []):
                if other in hidden:
                    other.become(hidden.pop(other))
            if opts.get("keep"):
                opts = dict(opts)
                opts["finals"] = [(other, other.copy()) for other in opts.get("reveal", [])]
            animation = build()
            if opts.get("overlay"):
                scene.add(animation.mobject)
            animation.begin()
            for other in opts.get("reveal", []):
                other.set_opacity(0)
            active.append((start + length, start, animation, opts))
            cursor += 1
        finish_until(time)
        for end, start, animation, opts in active:
            animation.interpolate(max(0, min(1, (time - start) / (end - start))))

    scene.play(UpdateFromAlphaFunc(Group(*objects), update, run_time=duration, rate_func=linear))
`;

export function generateManim(project: Project): { script: string; notes: string[] } {
  const { w, h } = STAGE_SIZES[project.format];
  const svg = project.objects.some((object) => !object.vector && !object.plane && (object.kind === 'svg' || !object.tex));
  const notes = new Set<string>();
  const byId = new Map(project.objects.map((object) => [object.id, object]));
  const ends = new Map<string, number>();
  const events: { start: number; time: number; id: string; code: string; entrance: boolean; overlay: boolean; keep?: boolean; reveal: string[] }[] = [];
  const infos = new Map<string, TexInfo>();
  const infoOf = (object: Obj2D) => {
    let info = infos.get(object.id);
    if (!info) infos.set(object.id, (info = texInfo(object)));
    return info;
  };
  // Transformaciones dirigidas glifo → glifo: Manim recibe un TransformFromCopy por pareja de glifos.
  const directed = directedGlyphClips(project.clips);
  const directedOf = new Map(directed.map((entry) => [entry.clip, entry]));
  const targeted = directedTargets(directed);
  const isEntrance = (clip: Clip) => clip.type === 'draw' || clip.type === 'appear';
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    const object = byId.get(clip.targetId.split('.')[0]);
    if (!object) continue;
    const dg = directedOf.get(clip);
    if (dg) {
      const from = byId.get(dg.spec.sourceObjectId);
      const to = byId.get(dg.spec.targetObjectId);
      if (!from || !to) {
        notes.add('Se omitieron clips de ecuaciones sin objeto de destino válido.');
        continue;
      }
      const fromInfo = infoOf(from);
      const toInfo = infoOf(to);
      if (!fromInfo.tokens || !toInfo.tokens) notes.add('Ecuaciones complejas: los índices de glifos pueden diferir de los de MathTex (verifica con eq[0][i]).');
      const begin = Math.max(clip.start, ends.get(`dir:${clip.id}`) ?? 0);
      ends.set(`dir:${clip.id}`, begin + clip.duration);
      const run = `run_time=${n(clip.duration)}`;
      dg.src.forEach((sourceIndex, pair) => {
        const source = glyphGroup(from.id, fromInfo, [sourceIndex]);
        const destination = glyphGroup(to.id, toInfo, [dg.dst[pair]]);
        if (!source || !destination) return;
        // TransformFromCopy anima el glifo destino desde una copia del origen; sin copia, el origen se reemplaza.
        events.push(dg.spec.keepSource
          ? { start: begin, time: clip.duration, id: destination, code: `TransformFromCopy(${source}, ${destination}, ${run})`, entrance: true, overlay: false, reveal: [] }
          : { start: begin, time: clip.duration, id: source, code: `ReplacementTransform(${source}, ${destination}, ${run})`, entrance: false, overlay: false, reveal: [destination] });
      });
      continue;
    }
    if (EQUATION_CLIPS.has(clip.type)) {
      const built = clip.targetId === object.id ? equationAnimation(clip, object, project, infoOf, notes, FRAME_HEIGHT / h) : null;
      if (!built) {
        notes.add('Se omitieron clips de ecuaciones sin objeto de destino válido.');
        continue;
      }
      const start = Math.max(clip.start, ends.get(built.key) ?? 0);
      if (start > clip.start + 1e-9) notes.add('Los clips superpuestos de un mismo objeto se ejecutan en secuencia.');
      ends.set(built.key, start + clip.duration);
      events.push({ start, time: clip.duration, id: object.id, code: built.code, entrance: false, overlay: built.overlay, keep: built.keep, reveal: built.reveal });
      continue;
    }
    let target = object.id;
    let scoped: string | undefined;
    if (isEntrance(clip) && object.kind === 'formula' && !object.vector && object.tex && clip.targetId === object.id) {
      // Write / FadeIn sobre glifos concretos (o sobre los que no llegan desde otro objeto).
      const info = infoOf(object);
      const scope = entranceScope(object, clip.parameters, targeted.get(object.id), info.count);
      if (scope) {
        const ref = glyphGroup(object.id, info, scope);
        if (!ref) continue;
        if (!info.tokens) notes.add('Ecuaciones complejas: los índices de glifos pueden diferir de los de MathTex (verifica con eq[0][i]).');
        scoped = target = ref;
      }
    }
    const code = animation(clip, object, w, h, scoped);
    if (clip.targetId !== object.id) notes.add('Los clips de nodos SVG se aplican al objeto completo.');
    if (clip.type === 'radar' || clip.type === 'glow') notes.add('Radar y brillo se aproximan con Indicate.');
    const start = Math.max(clip.start, ends.get(target) ?? 0);
    if (start > clip.start + 1e-9) notes.add('Los clips superpuestos de un mismo objeto se ejecutan en secuencia.');
    ends.set(target, start + clip.duration);
    events.push({ start, time: clip.duration, id: target, code: code!, entrance: clip.type === 'draw' || clip.type === 'appear', overlay: false, reveal: [] });
  }
  // Glifos de una ecuación destino que no llegan de otro objeto ni tienen clip de entrada: aparecen al llegar el último.
  for (const [objectId, set] of targeted) {
    const object = byId.get(objectId);
    if (!object) continue;
    const info = infoOf(object);
    const last = directed.filter((entry) => entry.spec.targetObjectId === objectId)
      .reduce((max, entry) => Math.max(max, entry.clip.start + entry.clip.duration), 0);
    const rest = Array.from({ length: info.count }, (_, index) => index).filter((index) => !set.has(index)
      && !project.clips.some((clip) => isEntrance(clip) && clip.targetId === objectId
        && entranceScope(object, clip.parameters, set, info.count)?.includes(index)));
    const ref = rest.length ? glyphGroup(objectId, info, rest) : null;
    if (!ref) continue;
    ends.set(ref, last + 0.05);
    events.push({ start: last, time: 0.05, id: ref, code: `FadeIn(${ref}, run_time=0.05)`, entrance: true, overlay: false, reveal: [] });
  }
  events.sort((a, b) => a.start - b.start);
  if (project.objects.some((object) => object.plane)) notes.add('Planos cartesianos: se exportan como NumberPlane; el tamaño de los números y los grosores se aproximan a las unidades de Manim.');
  if (svg) notes.add('Los SVG se incrustan. Manim interpreta sus estilos y filtros según su compatibilidad.');
  if (project.voice || project.clips.some((clip) => clip.sound)) notes.add('El audio queda fuera del script.');
  if (project.background === 'grid') notes.add('La cuadrícula se exporta como fondo liso.');
  if (Object.entries(project.styles).some(([id, style]) => id.includes('.') && Object.keys(style).some((key) => key !== 'vertices'))) notes.add('Los estilos del inspector aplicados a nodos SVG no se trasladan a Manim.');

  const body = project.objects.flatMap((object, index) =>
    [...objectCode(object, project.styles[object.id] ?? {}, w, h, project.styles), `${object.id}.set_z_index(${index})`, '']);
  const ids = project.objects.map((object) => object.id);
  const length = [...ends.values()].reduce((max, end) => Math.max(max, end), sceneDuration(project));
  if (events.length) {
    const options = (event: (typeof events)[number]) => {
      const entries = [event.overlay && '"overlay": True', event.keep && '"keep": True', event.reveal.length && `"reveal": [${event.reveal.join(', ')}]`].filter(Boolean);
      return `{${entries.join(', ')}}`;
    };
    body.push('events = [', ...events.map((event) => `    (${n(event.start)}, ${n(event.time)}, ${event.id}, ${event.entrance ? 'True' : 'False'}, lambda: ${event.code}, ${options(event)}),`),
      ']', `play_timeline(self, [${ids.join(', ')}], events, ${n(length)})`);
  } else {
    if (ids.length) body.push(`self.add(${ids.join(', ')})`);
    body.push(`self.wait(${n(length)})`);
  }
  return {
    notes: [...notes],
    script: [
      '# Ejecutar: manim escena.py EscenaMathMotion',
      ...[...notes].map((note) => '# ' + note),
      'from manim import *', 'import numpy as np',
      ...(svg ? ['from pathlib import Path', 'from tempfile import TemporaryDirectory'] : []),
      '',
      `config.pixel_width = ${w}`, `config.pixel_height = ${h}`,
      `config.frame_width = ${n(FRAME_HEIGHT * w / h)}`, `config.frame_height = ${FRAME_HEIGHT}`,
      `config.background_color = ${quoted(BACKGROUND_COLOR[project.background])}`, '',
      ...(svg ? [SVG_HELPER] : []), ...(events.length ? [TIMELINE_HELPER] : []),
      `class EscenaMathMotion(Scene):`,
      '    def construct(self):', ...body.map((line) => line ? '        ' + line : ''), '',
    ].join('\n'),
  };
}
