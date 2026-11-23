/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Box, CameraState, NodeStyle, Obj3D, Shape3D } from '../types';

/** Estado animado de un objeto 3D en un instante (calculado por el runtime). */
export interface State3D {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rot: { x: number; y: number; z: number };
  glow: number;
  /** null = sin animación de dibujo; 0..1 = progreso */
  draw: number | null;
}

export const defaultState3D = (): State3D => ({
  opacity: 1,
  dx: 0,
  dy: 0,
  scale: 1,
  rot: { x: 0, y: 0, z: 0 },
  glow: 0,
  draw: null,
});

const DEFAULT_COLORS: Record<Shape3D, { fill: string; stroke: string }> = {
  axes: { fill: '#e2e8f0', stroke: '#94a3b8' },
  paraboloid: { fill: '#38bdf8', stroke: '#7dd3fc' },
  sphere: { fill: '#a78bfa', stroke: '#c4b5fd' },
  vector: { fill: '#fde047', stroke: '#fde047' },
};

interface MatRec {
  mat: any;
  base: number;
  baseColor: any;
  kind: 'mesh' | 'line';
}
interface LineRec {
  geo: any;
  total: number;
}
interface Entry {
  id: string;
  shape: Shape3D;
  group: any;
  mats: MatRec[];
  lines: LineRec[];
  arrow?: any;
  arrowLen?: number;
  colorKey: string;
}

export class Scene3D {
  private entries = new Map<string, Entry>();
  private renderer: any;
  private scene: any;
  private camera: any;
  private lost = false;

  private constructor(
    private THREE: any,
    private host: HTMLElement,
    private W: number,
    private H: number,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(W, H, false);
    this.renderer.setClearColor(0x000000, 0);
    const c: HTMLCanvasElement = this.renderer.domElement;
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    c.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    c.addEventListener('webglcontextrestored', () => {
      this.lost = false;
    });
    host.appendChild(c);
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(40, W / H, 0.1, 200);
    this.scene.add(new T.AmbientLight(0xffffff, 0.75));
    const dl = new T.DirectionalLight(0xffffff, 1.6);
    dl.position.set(4, 8, 6);
    this.scene.add(dl);
  }

  /** Comprobación rápida de soporte WebGL (sin cargar Three.js). */
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  static async create(host: HTMLElement, W: number, H: number): Promise<Scene3D> {
    const probe = document.createElement('canvas');
    const gl = (probe.getContext('webgl2') || probe.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL no está disponible en este navegador o dispositivo.');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const THREE = await import('three');
    try {
      return new Scene3D(THREE, host, W, H);
    } catch (e) {
      throw new Error(`No se pudo iniciar WebGL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  resize(W: number, H: number) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
  }

  // ---------- Construcción ----------

  private track(e: Entry, obj: any, kind: 'mesh' | 'line', opacity = 1) {
    const mat = obj.material;
    mat.transparent = true;
    mat.opacity = opacity;
    e.mats.push({ mat, base: opacity, baseColor: mat.color.clone(), kind });
    if (kind === 'line') {
      const geo = obj.geometry;
      const total = geo.attributes.position.count;
      e.lines.push({ geo, total });
    }
  }

  private build(o: Obj3D, fill: string, stroke: string): Entry {
    const T = this.THREE;
    const e: Entry = { id: o.id, shape: o.shape, group: new T.Group(), mats: [], lines: [], colorKey: fill + stroke };
    const lineMat = (c: string) => new T.LineBasicMaterial({ color: new T.Color(c) });
    const meshMat = (c: string) =>
      new T.MeshStandardMaterial({ color: new T.Color(c), side: T.DoubleSide, roughness: 0.55, metalness: 0.05 });

    switch (o.shape) {
      case 'axes': {
        const defs: [number[], string][] = [
          [[-3.2, 0, 0, 3.2, 0, 0], '#f87171'],
          [[0, -3.2, 0, 0, 3.2, 0], '#4ade80'],
          [[0, 0, -3.2, 0, 0, 3.2], '#60a5fa'],
        ];
        defs.forEach(([pts, col], i) => {
          const g = new T.BufferGeometry();
          g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
          const l = new T.LineSegments(g, lineMat(col));
          e.group.add(l);
          this.track(e, l, 'line');
          const cone = new T.Mesh(new T.ConeGeometry(0.12, 0.4, 16), meshMat(col));
          cone.position.set(i === 0 ? 3.4 : 0, i === 1 ? 3.4 : 0, i === 2 ? 3.4 : 0);
          if (i === 0) cone.rotation.z = -Math.PI / 2;
          if (i === 2) cone.rotation.x = Math.PI / 2;
          e.group.add(cone);
          this.track(e, cone, 'mesh');
        });
        break;
      }
      case 'paraboloid': {
        const pts: any[] = [];
        for (let i = 0; i <= 28; i++) {
          const r = (i / 28) * 2;
          pts.push(new T.Vector2(r, 0.5 * r * r - 0.2));
        }
        const geo = new T.LatheGeometry(pts, 40);
        const mesh = new T.Mesh(geo, meshMat(fill));
        e.group.add(mesh);
        this.track(e, mesh, 'mesh', 0.45);
        const wire = new T.LineSegments(new T.WireframeGeometry(geo), lineMat(stroke));
        e.group.add(wire);
        this.track(e, wire, 'line', 0.9);
        break;
      }
      case 'sphere': {
        const geo = new T.SphereGeometry(1.4, 28, 18);
        const mesh = new T.Mesh(geo, meshMat(fill));
        e.group.add(mesh);
        this.track(e, mesh, 'mesh', 0.5);
        const wire = new T.LineSegments(new T.WireframeGeometry(geo), lineMat(stroke));
        e.group.add(wire);
        this.track(e, wire, 'line', 0.7);
        break;
      }
      case 'vector': {
        const dir = new T.Vector3(1, 1.2, 0.8).normalize();
        const len = 3;
        const arrow = new T.ArrowHelper(dir, new T.Vector3(0, 0, 0), len, new T.Color(fill), 0.55, 0.28);
        e.group.add(arrow);
        e.arrow = arrow;
        e.arrowLen = len;
        this.track(e, arrow.line, 'mesh'); // la línea de la flecha se anima por longitud, no por drawRange
        this.track(e, arrow.cone, 'mesh');
        break;
      }
    }
    return e;
  }

  private disposeEntry(e: Entry) {
    this.scene.remove(e.group);
    e.group.traverse((n: any) => {
      n.geometry?.dispose?.();
      const m = n.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    });
  }

  /** Reconcilia los objetos 3D de la escena con los del proyecto. */
  sync(objs: Obj3D[], styles: Record<string, NodeStyle>) {
    const ids = new Set(objs.map((o) => o.id));
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        this.disposeEntry(e);
        this.entries.delete(id);
      }
    }
    for (const o of objs) {
      const def = DEFAULT_COLORS[o.shape];
      const fill = styles[o.id]?.fill && styles[o.id].fill !== 'none' ? styles[o.id].fill! : def.fill;
      const stroke = styles[o.id]?.stroke && styles[o.id].stroke !== 'none' ? styles[o.id].stroke! : def.stroke;
      const cur = this.entries.get(o.id);
      if (cur && cur.shape === o.shape && cur.colorKey === fill + stroke) continue;
      if (cur) this.disposeEntry(cur);
      const e = this.build(o, fill, stroke);
      this.entries.set(o.id, e);
      this.scene.add(e.group);
    }
  }

  // ---------- Estado por fotograma ----------

  private applyCamera(cam: CameraState, azDelta: number) {
    const az = ((cam.az + azDelta) * Math.PI) / 180;
    const el = (cam.el * Math.PI) / 180;
    const aspectK = this.W / this.H < 1 ? 1.55 : 1;
    const d = cam.dist * aspectK;
    this.camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
    this.camera.lookAt(0, 0.4, 0);
    this.camera.updateMatrixWorld(true);
  }

  apply(objs: Obj3D[], states: Map<string, State3D>, cam: CameraState, camAzDelta: number) {
    const T = this.THREE;
    this.applyCamera(cam, camAzDelta);
    const right = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const dist = this.camera.position.length();
    const worldPerPx = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / this.H;

    for (const o of objs) {
      const e = this.entries.get(o.id);
      if (!e) continue;
      const s = states.get(o.id) ?? defaultState3D();
      const g = e.group;
      g.rotation.order = 'YXZ';
      g.rotation.set((s.rot.x * Math.PI) / 180, ((o.rotation + s.rot.y) * Math.PI) / 180, (s.rot.z * Math.PI) / 180);
      g.scale.setScalar(Math.max(0.0001, o.scale * s.scale));
      g.position.copy(right).multiplyScalar(s.dx * worldPerPx).addScaledVector(up, -s.dy * worldPerPx);
      const p = s.draw;
      g.visible = p === null || p > 0;
      const meshK = p === null ? 1 : Math.min(1, Math.max(0, (p - 0.65) / 0.35));
      for (const m of e.mats) {
        const k = m.kind === 'mesh' ? meshK : 1;
        m.mat.opacity = m.base * s.opacity * k;
        m.mat.color.copy(m.baseColor).lerp(new T.Color(0xffffff), Math.min(0.75, s.glow * 0.75));
        if (m.mat.emissive) {
          m.mat.emissive.copy(m.baseColor);
          m.mat.emissiveIntensity = s.glow * 0.8;
        }
      }
      for (const l of e.lines) {
        const n = p === null ? l.total : Math.floor((l.total * Math.min(1, p / 0.7)) / 2) * 2;
        l.geo.setDrawRange(0, n);
      }
      if (e.arrow) {
        const k = p === null ? 1 : Math.max(0.001, Math.min(1, p / 0.7));
        e.arrow.setLength(e.arrowLen! * k, 0.55 * k, 0.28 * k);
      }
    }
    this.render();
  }

  render() {
    if (this.lost) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Caja en coordenadas del escenario (px lógicos) de un objeto 3D. */
  getBox(id: string): Box | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const T = this.THREE;
    e.group.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(e.group);
    if (b.isEmpty()) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const v = new T.Vector3(x, y, z).project(this.camera);
          const px = (v.x * 0.5 + 0.5) * this.W;
          const py = (-v.y * 0.5 + 0.5) * this.H;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  dispose() {
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
  }
}
