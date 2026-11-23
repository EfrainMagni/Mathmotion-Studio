import { BACKGROUND_COLOR, STAGE_SIZES, is2D, sceneDuration, type Clip, type NodeStyle, type Obj2D, type Project, type SceneObject } from '../types';
import { VECTOR_FILL, VECTOR_STROKE, VECTOR_STROKE_WIDTH } from './vector';

const n = (value: number) => Number(value.toFixed(7)).toString();
const quoted = (value: string) => JSON.stringify(value);
const point = (x: number, y: number) => `np.array([${n(x)}, ${n(y)}, 0.0])`;
const FRAME_HEIGHT = 8;
const shape3d = {
  axes: 'ThreeDAxes(x_length=6.4, y_length=6.4, z_length=6.4)',
  sphere: 'Sphere(radius=1.4, resolution=(18, 24))',
  paraboloid: 'Surface(lambda u, v: np.array([u * np.cos(v), u * np.sin(v), 0.5 * u ** 2]), u_range=[0, 2], v_range=[0, TAU], resolution=(12, 24))',
  vector: 'Arrow3D(start=ORIGIN, end=3 * normalize(np.array([1, 0.8, 1.2])))',
};

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
  if (vector.tool === 'rectangle') return `Rectangle(width=${n(w)}, height=${n(h)})`;
  if (vector.tool === 'ellipse') {
    return Math.abs(w - h) < 0.00001 ? `Circle(radius=${n(w / 2)})` : `Ellipse(width=${n(w)}, height=${n(h)})`;
  }
  if (vector.tool === 'text') return `Text(${quoted(vector.text?.trim() ? vector.text : ' ')})`;
  const dx = object.bw <= 1 ? 0 : (vector.reverseX ? -w : w) / 2;
  const dy = object.bh <= 1 ? 0 : (vector.reverseY ? h : -h) / 2;
  return `Line(${point(-dx, -dy)}, ${point(dx, dy)})`;
}

function objectCode(object: SceneObject, style: NodeStyle, width: number, height: number) {
  const name = object.id;
  const unit = FRAME_HEIGHT / height;
  let constructor: string;
  if (!is2D(object)) constructor = shape3d[object.shape];
  else if (object.vector) constructor = vectorConstructor(object, unit);
  else if (object.kind === 'formula' && object.tex) constructor = `MathTex(${quoted(object.tex)})`;
  else constructor = `embedded_svg(${quoted(object.markup)})`;

  const commands = [`${name} = ${constructor}`];
  const vector = is2D(object) ? object.vector : undefined;
  const linear = vector?.tool === 'line' || vector?.tool === 'arrow';
  if (is2D(object)) {
    if (vector?.tool === 'text' || !vector) {
      commands.push(`if ${name}.width > 0: ${name}.scale_to_fit_width(${n(object.bw * unit)})`);
      if (vector?.tool === 'text') commands.push(`if ${name}.height > 0: ${name}.stretch_to_fit_height(${n(object.bh * unit)})`);
    }
  }

  const defaultFormulaColor = is2D(object) && object.kind === 'formula'
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
  if (is2D(object) && vector?.tool === 'arrow' && vector.tip !== 'none') {
    const tip = vector.tip === 'open' ? 'ArrowTriangleTip' : 'ArrowTriangleFilledTip';
    const tipLength = n(Math.min(0.16, 0.25 * Math.hypot(object.bw, object.bh) * unit));
    commands.push(`${name}.add_tip(tip_shape=${tip}, tip_length=${tipLength})`);
    if (vector.tip === 'both') commands.push(`${name}.add_tip(at_start=True, tip_length=${tipLength})`);
  }
  if (style.lineStyle === 'dotted' && is2D(object) && !hiddenStroke && (strokeWidth ?? 1) > 0) {
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
  if (object.scale !== 1) commands.push(`${name}.scale(${n(object.scale)})`);
  if (object.rotation) commands.push(`${name}.rotate(${n(is2D(object) ? -object.rotation : object.rotation)} * DEGREES, axis=${is2D(object) ? 'OUT' : 'UP'})`);
  if (is2D(object)) commands.push(`${name}.move_to(${point((object.x - width / 2) * unit, (height / 2 - object.y) * unit)})`);
  else if (style.tx || style.ty) commands.push(`${name}.shift(${point((style.tx ?? 0) * unit, -(style.ty ?? 0) * unit)})`);
  return commands;
}

function animation(clip: Clip, object: SceneObject, unit: number) {
  const id = object.id;
  const params = clip.parameters;
  const duration = `run_time=${n(clip.duration)}`;
  switch (clip.type) {
    case 'draw': {
      const write = is2D(object) && (object.kind === 'formula' || object.vector?.tool === 'text');
      return `${write ? 'Write' : 'Create'}(${id}, ${duration})`;
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
      const axis = is2D(object) || params.axis === 'z' ? 'OUT' : params.axis === 'x' ? 'RIGHT' : 'UP';
      return `Rotate(${id}, angle=${n(is2D(object) ? -degrees : degrees)} * DEGREES, axis=${axis}, ${duration})`;
    }
    case 'glow':
    case 'radar':
      return `Indicate(${id}, color=${quoted(cssColor(String(params.color)) ?? '#fde047')}, ${duration})`;
    case 'orbit': {
      const angle = typeof params.angle === 'number' ? params.angle : 180;
      return `ApplyMethod(orbit_camera.increment_value, ${n(angle)} * DEGREES, ${duration})`;
    }
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
    for start, length, mob, entrance, build in events:
        if mob not in seen and entrance:
            hidden[mob] = mob.copy()
            mob.set_opacity(0)
        seen.add(mob)
    active = []
    cursor = 0

    def finish_until(time):
        remaining = []
        for end, start, animation in active:
            if end <= time + 1e-9:
                animation.finish()
            else:
                remaining.append((end, start, animation))
        active[:] = remaining

    def update(_group, alpha):
        nonlocal cursor
        time = alpha * duration
        while cursor < len(events) and events[cursor][0] <= time + 1e-9:
            start, length, mob, entrance, build = events[cursor]
            finish_until(start)
            if mob in hidden:
                mob.become(hidden.pop(mob))
            animation = build()
            animation.begin()
            active.append((start + length, start, animation))
            cursor += 1
        finish_until(time)
        for end, start, animation in active:
            animation.interpolate(max(0, min(1, (time - start) / (end - start))))

    scene.play(UpdateFromAlphaFunc(Group(*objects), update, run_time=duration, rate_func=linear))
`;

export function generateManim(project: Project): { script: string; notes: string[] } {
  const { w, h } = STAGE_SIZES[project.format];
  const any3d = project.objects.some((object) => !is2D(object));
  const svg = project.objects.some((object) => is2D(object) && !object.vector && (object.kind === 'svg' || !object.tex));
  const notes = new Set<string>();
  const byId = new Map(project.objects.map((object) => [object.id, object]));
  const ends = new Map<string, number>();
  const events = [];
  for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
    const object = byId.get(clip.targetId.split('.')[0]);
    if (!object) continue;
    const orbit = clip.type === 'orbit';
    if (orbit && !any3d) continue;
    const target = orbit ? 'orbit_camera' : object.id;
    const code = animation(clip, object, FRAME_HEIGHT / h);
    if (clip.targetId !== object.id) notes.add('Los clips de nodos SVG se aplican al objeto completo.');
    if (clip.type === 'radar' || clip.type === 'glow') notes.add('Radar y brillo se aproximan con Indicate.');
    const start = Math.max(clip.start, ends.get(target) ?? 0);
    if (start > clip.start + 1e-9) notes.add('Los clips superpuestos de un mismo objeto se ejecutan en secuencia.');
    ends.set(target, start + clip.duration);
    events.push({ start, time: clip.duration, id: target, code, entrance: clip.type === 'draw' || clip.type === 'appear' });
  }
  events.sort((a, b) => a.start - b.start);
  const hasOrbit = ends.has('orbit_camera');
  if (svg) notes.add('Los SVG se incrustan. Manim interpreta sus estilos y filtros según su compatibilidad.');
  if (project.voice || project.clips.some((clip) => clip.sound)) notes.add('El audio queda fuera del script.');
  if (project.background === 'grid') notes.add('La cuadrícula se exporta como fondo liso.');
  if (project.objects.some((object) => !is2D(object) && project.styles[object.id]?.lineStyle === 'dotted')) {
    notes.add('Los contornos 3D punteados se exportan como contornos sólidos.');
  }
  if (Object.keys(project.styles).some((id) => id.includes('.'))) notes.add('Los estilos del inspector aplicados a nodos SVG no se trasladan a Manim.');

  const body = project.objects.flatMap((object, index) =>
    [...objectCode(object, project.styles[object.id] ?? {}, w, h), `${object.id}.set_z_index(${any3d && is2D(object) ? project.objects.length + index : index})`, '']);
  if (any3d) {
    body.unshift(`self.set_camera_orientation(phi=${n(90 - project.camera.el)} * DEGREES, theta=${n(project.camera.az - 90)} * DEGREES, zoom=${n(9 / project.camera.dist)})`, '');
    const flat = project.objects.filter(is2D).map((object) => object.id);
    if (flat.length) body.push(`self.add_fixed_in_frame_mobjects(${flat.join(', ')})`);
  }
  const ids = project.objects.map((object) => object.id);
  const length = [...ends.values()].reduce((max, end) => Math.max(max, end), sceneDuration(project));
  if (events.length) {
    if (hasOrbit) body.push('orbit_camera = self.camera.theta_tracker');
    body.push('events = [', ...events.map((event) => `    (${n(event.start)}, ${n(event.time)}, ${event.id}, ${event.entrance ? 'True' : 'False'}, lambda: ${event.code}),`),
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
      ...(hasOrbit ? ['config.renderer = "cairo"'] : []),
      `config.pixel_width = ${w}`, `config.pixel_height = ${h}`,
      `config.frame_width = ${n(FRAME_HEIGHT * w / h)}`, `config.frame_height = ${FRAME_HEIGHT}`,
      `config.background_color = ${quoted(BACKGROUND_COLOR[project.background])}`, '',
      ...(svg ? [SVG_HELPER] : []), ...(events.length ? [TIMELINE_HELPER] : []),
      `class EscenaMathMotion(${any3d ? 'ThreeDScene' : 'Scene'}):`,
      '    def construct(self):', ...body.map((line) => line ? '        ' + line : ''), '',
    ].join('\n'),
  };
}
