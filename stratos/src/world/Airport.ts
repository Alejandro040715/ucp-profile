// Valdera Air Base: runways with procedural markings (piano keys, designators,
// touchdown zone, aiming points, rubber deposits), taxiways with hold-short
// lines, concrete apron, hangars, hardened shelters, control tower, support
// buildings, fuel farm, radar, floodlight masts, windsocks, rotating beacon and
// a complete airfield lighting system (edge, centreline, TDZ, approach
// lights with sequenced flashers, PAPI, taxiway, obstruction lights).

import {
  BufferAttribute, CanvasTexture, Color, CylinderGeometry, Group, LinearFilter, Mesh, MeshStandardMaterial, Object3D,
  PlaneGeometry, BoxGeometry, SphereGeometry, ConeGeometry, LatheGeometry, Vector4, type Scene, AdditiveBlending, ShaderMaterial, DoubleSide,
  ExtrudeGeometry, Shape, type BufferGeometry, TorusGeometry,
} from 'three';
import { globals, CURVATURE_GLSL, FX_DEPTH_GLSL, fxDepth, decalOffset } from '../render/Globals.ts';
import { worldMaterial, GLSL_NOISE, type ShaderHook } from '../render/Materials.ts';
import { concreteMaterial, corrugatedMaterial, glazingMaterial, paintedMetalMaterial } from '../render/ProceduralMaterials.ts';
import { sunOcclusionHook } from './TerrainMaterial.ts';
import { AIRPORT, AIRPORT_ELEVATION, RUNWAYS, mainRwy, runwayFrame, type RunwayDef } from './WorldLayout.ts';
import { SHELTERS } from './Heightfield.ts';
import { LightPoints, type LightDef } from './LightPoints.ts';
import { DEG } from '../core/math.ts';

const Y = AIRPORT_ELEVATION;

// ---------------------------------------------------------------------------
// digit atlas for runway designators
function digitAtlas(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 640, 128);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 10; i++) {
    g.save();
    g.translate(i * 64 + 32, 66);
    g.scale(0.62, 1.05);
    g.font = 'bold 124px "Arial Narrow", Arial, sans-serif';
    g.fillText(String(i), 0, 0);
    g.restore();
  }
  const t = new CanvasTexture(c);
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const PAVEMENT_GLSL = /* glsl */ `
varying vec2 vPav;
varying vec3 vPavW;
uniform sampler2D uNoiseTex;
uniform sampler2D uDigits;
uniform float uWetness;
uniform float uLen;
uniform float uWid;
uniform vec4 uDigits4; // end A d1 d2, end B d1 d2
uniform float uKind;   // 0 runway, 1 taxiway, 2 apron, 3 stub/hold
${GLSL_NOISE}
float digitMask(vec2 local, float d) {
  // local: x in [0,1] across digit, y in [0,1] along digit (bottom -> top)
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return 0.0;
  vec2 uv = vec2((d + local.x) / 10.0, local.y);
  return texture2D(uDigits, uv).r;
}
float rwyPaint(float a, float c) {
  float W = uWid, L = uLen;
  float ac = abs(c);
  float paint = 0.0;
  float de = min(a, L - a);
  bool endA = a < L * 0.5;
  // side stripes
  paint += step(W * 0.5 - 1.2, ac) * step(ac, W * 0.5 - 0.3);
  // centreline 30 m dash / 20 m gap
  paint += step(ac, 0.45) * step(fract((a - 70.0) / 50.0), 0.6) * step(80.0, de);
  // threshold bar + piano keys
  paint += step(2.0, de) * step(de, 3.8) * step(ac, W * 0.5 - 0.3);
  float keyW = W > 40.0 ? 1.8 : 1.5;
  paint += step(6.0, de) * step(de, 36.0) * step(ac, W * 0.5 - 2.0) * step(keyW * 0.5, ac) * step(0.5, fract((ac - keyW * 0.5) / (keyW * 2.0)));
  // designators (9 m tall, 3 m wide each, read from the approach)
  if (de > 46.0 && de < 56.0) {
    float t = (de - 46.0) / 9.5;
    float side = endA ? c : -c;                // pilot's right is +
    vec2 digs = endA ? uDigits4.xy : uDigits4.zw;
    float d1 = digitMask(vec2((side + 4.2) / 3.4, t), digs.x);
    float d2 = digitMask(vec2((side - 0.8) / 3.4, t), digs.y);
    paint += max(d1, d2);
  }
  // aiming point
  paint += step(400.0, de) * step(de, 460.0) * step(6.0, ac) * step(ac, 15.0);
  // touchdown zone bars
  for (int i = 0; i < 5; i++) {
    float z = i == 0 ? 150.0 : i == 1 ? 300.0 : i == 2 ? 600.0 : i == 3 ? 750.0 : 900.0;
    float n = i < 2 ? 3.0 : i < 4 ? 2.0 : 1.0;
    float inZ = step(z, de) * step(de, z + 22.5);
    float x = ac - 6.0;
    paint += inZ * step(0.0, x) * step(x, n * 4.5 - 1.5) * step(fract(x / 4.5), 0.667);
  }
  return clamp(paint, 0.0, 1.0);
}
`;

const pavementHook = (u: Record<string, { value: unknown }>): ShaderHook => (shader) => {
  Object.assign(shader.uniforms, u);
  shader.uniforms.uNoiseTex = globals.uNoiseTex;
  shader.uniforms.uWetness = globals.uWetness;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 pav;\nvarying vec2 vPav;\nvarying vec3 vPavW;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPav = pav;\nvPavW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${PAVEMENT_GLSL}\nfloat pvRough; float pvBump; float pvWet;`)
    .replace(
      '#include <map_fragment>',
      /* glsl */ `
      {
        float a = vPav.x, c = vPav.y;
        vec2 wp = vPavW.xz;
        float n1 = texture2D(uNoiseTex, wp / 61.0).r;
        float n2 = texture2D(uNoiseTex, wp / 7.3).a;
        float n3 = texture2D(uNoiseTex, wp / 1.7).b;
        vec3 col;
        float paint = 0.0;
        vec3 paintCol = vec3(0.78, 0.78, 0.76);
        pvBump = n3 * 0.5;
        if (uKind < 0.5) {
          // asphalt runway with concrete ends
          col = vec3(0.055, 0.055, 0.058) * (0.8 + 0.4 * n1) * (0.9 + 0.2 * n2);
          float de = min(a, uLen - a);
          // patch repairs
          vec2 pc = floor(vec2(a / 23.0, c / 7.0));
          float ph = hash12(pc);
          if (ph > 0.93) col *= 0.75;
          // rubber deposits in the touchdown zones + skid streaks
          float rub = smoothstep(120.0, 260.0, de) * (1.0 - smoothstep(700.0, 1100.0, de)) * (1.0 - smoothstep(4.0, 13.0, abs(c)));
          float streaks = vnoise(vec2(a * 0.03, c * 2.2)) * vnoise(vec2(a * 0.11, c * 4.0));
          col *= 1.0 - rub * (0.35 + 0.5 * streaks);
          paint = rwyPaint(a, c);
          paint *= 0.72 + 0.28 * n2;
          paint *= 1.0 - rub * 0.55;
          pvRough = mix(0.88, 0.7, paint);
        } else if (uKind < 1.5) {
          // taxiway asphalt + yellow centreline and edge lines
          col = vec3(0.07, 0.068, 0.066) * (0.8 + 0.4 * n1) * (0.9 + 0.2 * n2);
          float ac = abs(c);
          paintCol = vec3(0.8, 0.55, 0.06);
          paint = step(ac, 0.15) + step(uWid * 0.5 - 0.9, ac) * step(ac, uWid * 0.5 - 0.75) + step(uWid * 0.5 - 0.6, ac) * step(ac, uWid * 0.5 - 0.45);
          // hold-short marking near the runway end of stubs (uDigits4.x = along position, 0 = none)
          if (uDigits4.x > 0.0) {
            float h = a - uDigits4.x;
            float solid = step(0.0, h) * step(h, 0.3) + step(0.6, h) * step(h, 0.9);
            float dashed = (step(1.2, h) * step(h, 1.5) + step(1.8, h) * step(h, 2.1)) * step(0.5, fract(c / 1.8));
            paint += (solid + dashed) * step(ac, uWid * 0.5 - 0.5);
          }
          paint = clamp(paint, 0.0, 1.0) * (0.7 + 0.3 * n2);
          pvRough = 0.86;
        } else {
          // concrete apron slabs with joints, oil stains, stand markings
          vec2 sl = floor(vec2(a, c) / 5.0);
          vec2 sf = fract(vec2(a, c) / 5.0);
          float sh = hash12(sl);
          col = vec3(0.24, 0.235, 0.225) * (0.88 + 0.12 * sh) * (0.85 + 0.3 * n2);
          float joint = 1.0 - smoothstep(0.0, 0.012, min(min(sf.x, 1.0 - sf.x), min(sf.y, 1.0 - sf.y)));
          col *= 1.0 - joint * 0.45;
          float oil = smoothstep(0.7, 0.85, texture2D(uNoiseTex, wp / 13.0).g) * smoothstep(0.55, 0.8, n1);
          col = mix(col, vec3(0.08, 0.075, 0.07), oil * 0.45);
          // parking stand lead-in lines every 60 m across the apron width
          paintCol = vec3(0.8, 0.55, 0.06);
          float sa = mod(a + 30.0, 60.0) - 30.0;
          paint = step(abs(sa), 0.15) * step(abs(c), uWid * 0.5 - 8.0);
          paint += step(abs(abs(sa) - 12.0), 0.12) * step(uWid * 0.5 - 40.0, c) * step(c, uWid * 0.5 - 8.0);
          paint = clamp(paint, 0.0, 1.0) * (0.75 + 0.25 * n2);
          pvRough = 0.9 - oil * 0.3;
          pvBump = n3 * 0.4 - joint * 2.0;
        }
        col = mix(col, paintCol, paint);
        // wetness: darker, glossy, standing water in low spots
        float puddle = smoothstep(0.6, 0.75, texture2D(uNoiseTex, wp / 31.0).g);
        pvWet = uWetness * (0.55 + 0.45 * puddle);
        col *= 1.0 - 0.45 * pvWet;
        pvRough = mix(pvRough, 0.08, pvWet * (0.4 + 0.6 * puddle));
        diffuseColor.rgb = col;
      }`,
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pvRough;')
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      {
        float bh = pvBump * 0.004 * (1.0 - pvWet);
        vec2 dHdxy = vec2(dFdx(bh), dFdy(bh));
        vec3 vSigmaX = dFdx(-vViewPosition);
        vec3 vSigmaY = dFdy(-vViewPosition);
        vec3 R1 = cross(vSigmaY, normal);
        vec3 R2 = cross(normal, vSigmaX);
        float fDet = dot(vSigmaX, R1);
        vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
        if (abs(fDet) > 1e-9) normal = normalize(abs(fDet) * normal - vGrad);
      }`,
    );
};

let digitTex: CanvasTexture | null = null;

function pavementMaterial(kind: number, len: number, wid: number, digits = [0, 0, 0, 0]): MeshStandardMaterial {
  digitTex ??= digitAtlas();
  const u = {
    uDigits: { value: digitTex },
    uLen: { value: len },
    uWid: { value: wid },
    uDigits4: { value: new Vector4(digits[0], digits[1], digits[2], digits[3]) },
    uKind: { value: kind },
  };
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, ...decalOffset(2 + (2 - Math.min(kind, 2)), 4 + (2 - Math.min(kind, 2)) * 2) });
  return worldMaterial(m, { key: `pav${kind}`, hooks: [pavementHook(u), sunOcclusionHook] });
}

/** Flat rectangle in the XZ plane with a `pav` attribute = (along from start, across) in metres. */
function pavementRect(len: number, wid: number, segL = 1, segW = 1): BufferGeometry {
  const g = new PlaneGeometry(wid, len, segW, segL);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const pav = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    pav[i * 2] = -pos.getZ(i) + len / 2;
    pav[i * 2 + 1] = pos.getX(i);
  }
  g.setAttribute('pav', new BufferAttribute(pav, 2));
  return g;
}

function placeRect(mesh: Mesh, cx: number, cz: number, headingDeg: number, y: number): Mesh {
  mesh.position.set(cx, y, cz);
  mesh.rotation.y = -headingDeg * DEG;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------
// ground light pools (fake floodlight illumination on the apron at night)
const poolVert = /* glsl */ `
varying vec2 vUv;
varying float vViewZ;
${CURVATURE_GLSL}
void main() {
  vUv = uv;
  vec3 wp = applyCurvature((modelMatrix * vec4(position, 1.0)).xyz);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const poolFrag = /* glsl */ `
varying vec2 vUv;
varying float vViewZ;
uniform float uLightsOn;
uniform vec3 uColor;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd + 1.5) discard;
  float r = length(vUv - 0.5) * 2.0;
  float f = pow(max(0.0, 1.0 - r), 2.2);
  gl_FragColor = vec4(uColor * f * uLightsOn * 0.05, 1.0);
}`;

export interface RunwayInfo {
  def: RunwayDef;
  thresholdA: [number, number];
  thresholdB: [number, number];
  dir: [number, number];
}

export class Airport {
  readonly group = new Group();
  readonly lights: LightPoints;
  private windsocks: Object3D[] = [];
  private beacon: Object3D | null = null;
  private beaconLight: Mesh | null = null;
  readonly runways: RunwayInfo[] = [];
  readonly fxGroup = new Group();

  constructor(scene: Scene, fxScene: Scene) {
    const lights: LightDef[] = [];
    this.buildRunways(lights);
    this.buildTaxiways(lights);
    this.buildBuildings(lights);
    this.lights = new LightPoints(lights);
    fxScene.add(this.lights.points);
    fxScene.add(this.fxGroup);
    scene.add(this.group);
  }

  private buildRunways(lights: LightDef[]): void {
    for (const r of RUNWAYS) {
      const f = runwayFrame(r);
      const dA = r.name[0].padStart(2, '0').split('').map(Number);
      const dB = r.name[1].padStart(2, '0').split('').map(Number);
      const mat = pavementMaterial(0, r.length, r.width, [dA[0], dA[1], dB[0], dB[1]]);
      const geo = pavementRect(r.length, r.width, 60, 4);
      const mesh = placeRect(new Mesh(geo, mat), r.center[0], r.center[1], r.heading, Y + 0.05);
      this.group.add(mesh);
      // shoulders (blast pads at each end)
      const shoulderMat = pavementMaterial(1, 120, r.width + 14);
      for (const s of [-1, 1]) {
        const cx = r.center[0] + f.dirX * s * (r.length / 2 + 60);
        const cz = r.center[1] + f.dirZ * s * (r.length / 2 + 60);
        this.group.add(placeRect(new Mesh(pavementRect(120, r.width + 14), shoulderMat), cx, cz, r.heading, Y + 0.03));
      }
      const tA: [number, number] = [r.center[0] - f.dirX * r.length / 2, r.center[1] - f.dirZ * r.length / 2];
      const tB: [number, number] = [r.center[0] + f.dirX * r.length / 2, r.center[1] + f.dirZ * r.length / 2];
      this.runways.push({ def: r, thresholdA: tA, thresholdB: tB, dir: [f.dirX, f.dirZ] });

      // ---- runway lighting
      const at = (along: number, across: number, h = 0.35): [number, number, number] => [
        tA[0] + f.dirX * along + f.perpX * across,
        Y + h,
        tA[1] + f.dirZ * along + f.perpZ * across,
      ];
      const W = r.width;
      for (let a = 0; a <= r.length + 0.1; a += 60) {
        for (const s of [-1, 1]) {
          const caution = a > r.length - 600;
          lights.push({ pos: at(a, s * (W / 2 + 1.5)), color: caution ? [1, 0.75, 0.3] : [1, 0.93, 0.8], size: 0.7, intensity: 2.2 });
        }
      }
      for (let a = 30; a < r.length; a += 30) {
        const red = a > r.length - 300 ? true : a > r.length - 900 ? Math.floor(a / 30) % 2 === 0 : false;
        lights.push({ pos: at(a, 0, 0.08), color: red ? [1, 0.12, 0.05] : [1, 0.95, 0.85], size: 0.45, intensity: 1.4 });
      }
      // threshold (green, facing the approach) and end lights (red, facing the runway)
      for (let x = -W / 2; x <= W / 2 + 0.1; x += 3) {
        lights.push({ pos: at(-1, x), color: [0.15, 1, 0.35], size: 0.6, intensity: 2.5, dir: (r.heading + 180) % 360 });
        lights.push({ pos: at(-1, x), color: [1, 0.08, 0.05], size: 0.5, intensity: 1.5, dir: r.heading });
        lights.push({ pos: at(r.length + 1, x), color: [0.15, 1, 0.35], size: 0.6, intensity: 2.5, dir: r.heading });
        lights.push({ pos: at(r.length + 1, x), color: [1, 0.08, 0.05], size: 0.5, intensity: 1.5, dir: (r.heading + 180) % 360 });
      }
      // touchdown zone barrettes
      for (let a = 60; a <= 900; a += 60) {
        for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
          lights.push({ pos: at(a, s * (9 + k * 1.5), 0.08), color: [1, 0.95, 0.85], size: 0.35, intensity: 1.0, dir: r.heading });
          lights.push({ pos: at(r.length - a, s * (9 + k * 1.5), 0.08), color: [1, 0.95, 0.85], size: 0.35, intensity: 1.0, dir: (r.heading + 180) % 360 });
        }
      }
      // PAPI on the left of each threshold (seen from the approach)
      const papiAngles = [3.5, 3.17, 2.83, 2.5];
      for (let i = 0; i < 4; i++) {
        lights.push({ pos: at(300, -(W / 2 + 15 + i * 9), 0.9), color: [1, 1, 1], size: 1.4, intensity: 4.5, dir: (r.heading + 180) % 360, papi: papiAngles[i], day: true });
        lights.push({ pos: at(r.length - 300, W / 2 + 15 + i * 9, 0.9), color: [1, 1, 1], size: 1.4, intensity: 4.5, dir: r.heading, papi: papiAngles[i], day: true });
      }
      // approach lighting (main runway end A gets a full ALS with sequenced flashers)
      const alsLen = r.id === 'main' ? 900 : 420;
      for (let d = 30; d <= alsLen; d += 30) {
        const bar = d === 300 ? 15 : 2.4;
        for (let x = -bar; x <= bar + 0.01; x += bar > 3 ? 1.5 : 1.2) {
          lights.push({ pos: at(-d, x, 0.6 + d * 0.004), color: [1, 0.95, 0.85], size: 0.6, intensity: 2.2, dir: (r.heading + 180) % 360 });
        }
        if (d <= 270) for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
          lights.push({ pos: at(-d, s * (10 + k * 1.5), 0.5), color: [1, 0.1, 0.05], size: 0.55, intensity: 2.0, dir: (r.heading + 180) % 360 });
        }
        if (d >= 300) {
          // "rabbit" sequenced flashers running towards the threshold, twice per second
          const phase = (alsLen - d) / alsLen;
          lights.push({ pos: at(-d, 0, 1.2 + d * 0.004), color: [0.85, 0.9, 1], size: 2.4, intensity: 9, dir: (r.heading + 180) % 360, blink: [0.5, -phase * 0.5, 0.04] });
        }
      }
    }
  }

  private buildTaxiways(lights: LightDef[]): void {
    const off = AIRPORT.taxiwayOffset;
    const add = (along: number, across: number, len: number, wid: number, heading: number, kind: number, hold = 0, y = Y + 0.04) => {
      const [x, z] = mainRwy(along, across);
      const mat = pavementMaterial(kind, len, wid, [hold, 0, 0, 0]);
      this.group.add(placeRect(new Mesh(pavementRect(len, wid, Math.max(1, Math.round(len / 50)), 1), mat), x, z, heading, y));
      return { x, z };
    };
    // parallel taxiway
    add(0, off, 3000, 23, 350, 1);
    // stubs (perpendicular, running from taxiway towards the runway: heading 260 = west)
    for (const a of [-1450, -500, 500, 1450]) add(a, off / 2, off, 26, 260, 1, off - 60);
    // apron + links
    const ap = AIRPORT.apron;
    add(ap.along, ap.across, ap.halfLength * 2, ap.halfWidth * 2, 350, 2, 0, Y + 0.035);
    for (const a of [-480, 180]) add(a, (off + ap.across - ap.halfWidth) / 2 + 5, ap.across - ap.halfWidth - off + 10, 30, 80, 1);
    // shelter pads
    for (const a of SHELTERS) add(a, (off + 318) / 2, 318 - off, 22, 80, 2, 0, Y + 0.035);
    // taxiway edge lights (blue) and centreline (green)
    for (let a = -1500; a <= 1500; a += 60) {
      for (const s of [-1, 1]) {
        const [x, z] = mainRwy(a, off + s * 13);
        lights.push({ pos: [x, Y + 0.3, z], color: [0.15, 0.3, 1], size: 0.45, intensity: 1.6 });
      }
      const [x, z] = mainRwy(a + 30, off);
      lights.push({ pos: [x, Y + 0.06, z], color: [0.2, 1, 0.4], size: 0.3, intensity: 0.9 });
    }
    // apron edge lights
    for (let a = ap.along - ap.halfLength; a <= ap.along + ap.halfLength; a += 60) {
      const [x, z] = mainRwy(a, ap.across - ap.halfWidth);
      lights.push({ pos: [x, Y + 0.3, z], color: [0.15, 0.3, 1], size: 0.45, intensity: 1.6 });
    }
  }

  private buildBuildings(lights: LightDef[]): void {
    const ap = AIRPORT.apron;
    const place = (o: Object3D, along: number, across: number, headingDeg: number, y = Y) => {
      const [x, z] = mainRwy(along, across);
      o.position.set(x, y, z);
      o.rotation.y = -headingDeg * DEG;
      this.group.add(o);
      o.traverse((c) => {
        if ((c as Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      return o;
    };
    const steel = corrugatedMaterial(new Color(0.36, 0.38, 0.37));
    const steelDark = corrugatedMaterial(new Color(0.22, 0.24, 0.24));
    const concrete = concreteMaterial();
    const concreteDark = concreteMaterial(new Color(0.3, 0.3, 0.28));
    const white = paintedMetalMaterial(0xd8d8d2, 0.55);
    const red = paintedMetalMaterial(0x9a1d14, 0.5);
    const yellow = paintedMetalMaterial(0xc89a14, 0.5);
    const dark = paintedMetalMaterial(0x23262a, 0.6);
    const glass = glazingMaterial(new Color(1.0, 0.85, 0.6), 1.4);
    const towerGlass = glazingMaterial(new Color(0.55, 0.85, 1.0), 0.9);

    // ---- hangars (arched roof), doors facing the apron (west)
    const hangarProfile = new Shape();
    const hw = 30, hh = 9, archH = 13;
    hangarProfile.moveTo(-hw, 0);
    hangarProfile.lineTo(-hw, hh);
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = -hw + t * hw * 2;
      hangarProfile.lineTo(x, hh + Math.sin(t * Math.PI) * archH);
    }
    hangarProfile.lineTo(hw, 0);
    hangarProfile.lineTo(-hw, 0);
    const hangarGeo = new ExtrudeGeometry(hangarProfile, { depth: 64, bevelEnabled: false, curveSegments: 1 });
    hangarGeo.translate(0, 0, -32);
    for (const [i, a] of [-470, -250, -30].entries()) {
      const h = new Group();
      const body = new Mesh(hangarGeo, i === 1 ? steelDark : steel);
      body.rotation.y = Math.PI / 2; // profile spans along-axis, extrusion across
      h.add(body);
      // door panels (slightly inset, darker), door frame and number
      const door = new Mesh(new BoxGeometry(0.4, hh + 6, hw * 1.7), dark);
      door.position.set(-32.1, (hh + 6) / 2, 0);
      h.add(door);
      const lintel = new Mesh(new BoxGeometry(0.8, 1.2, hw * 2), red);
      lintel.position.set(-32.2, hh + 6.6, 0);
      h.add(lintel);
      // interior light slit when the door is "ajar"
      const slit = new Mesh(new BoxGeometry(0.2, hh + 5.6, 2.2), glass);
      slit.position.set(-32.4, (hh + 6) / 2, 6 + i * 3);
      h.add(slit);
      place(h, a, ap.across + ap.halfWidth + 34, 350);
      // obstruction light on the roof
      const [x, z] = mainRwy(a, ap.across + ap.halfWidth + 34);
      lights.push({ pos: [x, Y + hh + archH + 0.6, z], color: [1, 0.1, 0.05], size: 1, intensity: 3, blink: [1.5, i * 0.2, 0.5] });
      // door floodlights
      for (const s of [-1, 1]) {
        const [lx, lz] = mainRwy(a + s * 22, ap.across + ap.halfWidth + 1.5);
        lights.push({ pos: [lx, Y + hh + 5, lz], color: [1, 0.85, 0.6], size: 1.4, intensity: 3.5, dir: 260 });
      }
    }

    // ---- hardened aircraft shelters (half-cylinder concrete), facing the taxiway (west)
    const shelterGeo = new CylinderGeometry(13, 13, 36, 24, 1, true, 0, Math.PI);
    shelterGeo.rotateZ(Math.PI / 2);
    shelterGeo.rotateY(Math.PI / 2);
    const backWall = new CylinderGeometry(13, 13, 1.2, 24, 1, false, 0, Math.PI);
    for (const a of SHELTERS) {
      const g = new Group();
      const shell = new Mesh(shelterGeo, concrete);
      shell.material.side = DoubleSide;
      g.add(shell);
      const back = new Mesh(backWall, concreteDark);
      back.rotation.set(0, 0, Math.PI / 2);
      back.rotation.y = Math.PI / 2;
      back.position.set(18, 0, 0);
      g.add(back);
      const doorL = new Mesh(new BoxGeometry(1.2, 9, 11), concreteDark);
      doorL.position.set(-18.4, 4.5, -13);
      g.add(doorL);
      const doorR = doorL.clone();
      doorR.position.z = 13;
      g.add(doorR);
      // earth berm hint
      place(g, a, 336, 350);
      const [x, z] = mainRwy(a, 312);
      lights.push({ pos: [x, Y + 10.5, z], color: [1, 0.85, 0.6], size: 1.2, intensity: 2.5, dir: 260 });
    }

    // ---- control tower
    const tower = new Group();
    const base = new Mesh(new BoxGeometry(26, 9, 18), concrete);
    base.position.y = 4.5;
    tower.add(base);
    const baseWin = new Mesh(new BoxGeometry(26.2, 1.6, 18.2), glass);
    baseWin.position.y = 6;
    tower.add(baseWin);
    const shaft = new Mesh(new BoxGeometry(6, 26, 6), white);
    shaft.position.set(6, 13 + 9, 0);
    tower.add(shaft);
    const cabFloor = new Mesh(new CylinderGeometry(6.4, 5.2, 2.4, 8), white);
    cabFloor.position.set(6, 36.2, 0);
    tower.add(cabFloor);
    const cab = new Mesh(new CylinderGeometry(6.6, 5.9, 4.2, 8, 1, true), towerGlass);
    cab.position.set(6, 39.5, 0);
    tower.add(cab);
    const roof = new Mesh(new CylinderGeometry(7.4, 7.0, 0.8, 8), dark);
    roof.position.set(6, 42, 0);
    tower.add(roof);
    const mast = new Mesh(new CylinderGeometry(0.12, 0.18, 7, 6), white);
    mast.position.set(6, 45.9, 0);
    tower.add(mast);
    // rotating beacon
    this.beacon = new Group();
    this.beacon.position.set(6, 49.6, 0);
    const bHead = new Mesh(new CylinderGeometry(0.45, 0.45, 0.6, 10), dark);
    this.beacon.add(bHead);
    tower.add(this.beacon);
    place(tower, AIRPORT_TOWER.along, AIRPORT_TOWER.across, 350);
    const [tx, tz] = mainRwy(AIRPORT_TOWER.along, AIRPORT_TOWER.across);
    lights.push({ pos: [tx, Y + 49.6, tz], color: [1, 0.1, 0.05], size: 1.2, intensity: 4, blink: [1.2, 0, 0.5], day: true });

    // ---- ops building / squadron building / fire station
    const ops = new Group();
    const opsBody = new Mesh(new BoxGeometry(48, 8, 20), concrete);
    opsBody.position.y = 4;
    ops.add(opsBody);
    for (const yy of [2.2, 5.6]) {
      const w = new Mesh(new BoxGeometry(48.2, 1.4, 20.2), glass);
      w.position.y = yy;
      ops.add(w);
    }
    const opsRoof = new Mesh(new BoxGeometry(49, 0.6, 21), dark);
    opsRoof.position.y = 8.3;
    ops.add(opsRoof);
    place(ops, -700, 690, 350);
    const fire = new Group();
    const fb = new Mesh(new BoxGeometry(30, 9, 16), white);
    fb.position.y = 4.5;
    fire.add(fb);
    for (let k = 0; k < 4; k++) {
      const d = new Mesh(new BoxGeometry(5.5, 6, 0.3), red);
      d.position.set(-10.5 + k * 7, 3, -8.1);
      fire.add(d);
    }
    place(fire, -560, 600, 80);

    // ---- fuel farm
    for (let k = 0; k < 4; k++) {
      const t = new Mesh(new CylinderGeometry(8, 8, 11, 28), white);
      t.position.y = 5.5;
      const cap = new Mesh(new CylinderGeometry(8.2, 8.2, 0.4, 28), dark);
      cap.position.y = 11.2;
      const g = new Group();
      g.add(t, cap);
      place(g, -720 + (k % 2) * 24, 820 + Math.floor(k / 2) * 24, 0);
    }
    // ---- radar dome on a lattice-ish tower
    const radar = new Group();
    const rt = new Mesh(new CylinderGeometry(2.2, 3.2, 16, 6), white);
    rt.position.y = 8;
    const dome = new Mesh(new SphereGeometry(5.2, 24, 16), white);
    dome.position.y = 19;
    radar.add(rt, dome);
    place(radar, 420, 600, 0);
    const [rx, rz] = mainRwy(420, 600);
    lights.push({ pos: [rx, Y + 24.6, rz], color: [1, 0.1, 0.05], size: 1, intensity: 3, blink: [2, 0.3, 0.5], day: true });

    // ---- apron floodlight masts + light pools
    const poolMat = new ShaderMaterial({
      vertexShader: poolVert,
      fragmentShader: poolFrag,
      uniforms: { uLightsOn: globals.uLightsOn, uColor: { value: new Color(1.0, 0.78, 0.5) }, uCurvOrigin: globals.uCurvOrigin, ...fxDepth },
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    for (let a = ap.along - ap.halfLength + 60; a <= ap.along + ap.halfLength - 60; a += 150) {
      const mast = new Mesh(new CylinderGeometry(0.25, 0.4, 24, 8), white);
      mast.position.y = 12;
      const head = new Mesh(new BoxGeometry(2.4, 0.6, 1.2), dark);
      head.position.y = 24.2;
      const m = new Group();
      m.add(mast, head);
      place(m, a, ap.across + ap.halfWidth - 4, 0);
      const [mx, mz] = mainRwy(a, ap.across + ap.halfWidth - 4);
      for (const s of [-0.8, 0, 0.8]) lights.push({ pos: [mx + s, Y + 24, mz], color: [1, 0.85, 0.6], size: 1.6, intensity: 6, dir: 260 });
      const pool = new Mesh(new PlaneGeometry(130, 130), poolMat);
      pool.rotation.x = -Math.PI / 2;
      const [px, pz] = mainRwy(a, ap.across + ap.halfWidth - 60);
      pool.position.set(px, Y + 0.2, pz);
      this.fxGroup.add(pool);
    }

    // ---- windsocks near both runway ends (west side)
    for (const a of [-1250, 1250]) {
      const ws = new Group();
      const pole = new Mesh(new CylinderGeometry(0.06, 0.09, 6, 6), white);
      pole.position.y = 3;
      ws.add(pole);
      const ring = new Mesh(new TorusGeometry(0.45, 0.04, 6, 16), white);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(0, 6, 0);
      const sockGeo = new ConeGeometry(0.45, 3.6, 12, 4, true);
      sockGeo.rotateZ(Math.PI / 2);
      sockGeo.translate(1.8, 0, 0);
      // alternating stripes via vertex colors
      const cols = new Float32Array(sockGeo.attributes.position.count * 3);
      for (let i = 0; i < sockGeo.attributes.position.count; i++) {
        const x = sockGeo.attributes.position.getX(i);
        const stripe = Math.floor((x / 3.6) * 5) % 2;
        cols.set(stripe ? [0.95, 0.95, 0.92] : [0.9, 0.25, 0.05], i * 3);
      }
      sockGeo.setAttribute('color', new BufferAttribute(cols, 3));
      const sockMat = worldMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }));
      const sock = new Mesh(sockGeo, sockMat);
      const pivot = new Group();
      pivot.position.y = 6;
      pivot.add(sock);
      ws.add(pivot);
      ws.userData.pivot = pivot;
      ws.userData.sock = sock;
      place(ws, a, -70, 0);
      this.windsocks.push(ws);
      const [wx, wz] = mainRwy(a, -70);
      lights.push({ pos: [wx, Y + 6.5, wz], color: [1, 0.95, 0.85], size: 0.8, intensity: 2 });
    }
    // perimeter / approach obstruction: a few lit masts
    void lights;
    void LatheGeometry;
  }

  update(time: number, windFromDeg: number, windSpeed: number): void {
    // windsocks point downwind, droop in light wind, flutter
    for (const ws of this.windsocks) {
      const pivot = ws.userData.pivot as Object3D;
      const downwind = (windFromDeg + 180) * DEG;
      pivot.rotation.y = -(downwind - Math.PI / 2) - ws.rotation.y * 0 + Math.sin(time * 3.1) * 0.05;
      const droop = Math.max(0, 1 - windSpeed / 8);
      pivot.rotation.z = -droop * 1.2 + Math.sin(time * 5.3) * 0.03 * (1 - droop);
      const sock = ws.userData.sock as Mesh;
      sock.scale.y = sock.scale.z = 0.85 + 0.15 * Math.min(1, windSpeed / 6);
    }
    if (this.beacon) this.beacon.rotation.y = time * 2.6;
    void this.beaconLight;
  }
}

const AIRPORT_TOWER = { along: -780, across: 570 };
