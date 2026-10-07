// Visual effects bound to an aircraft: afterburner flame with shock diamonds,
// exhaust heat haze, wing upper-surface condensation, LERX vortex cores,
// transonic vapour cone, wingtip vortex trails, contrails, tyre smoke,
// ground dust / water spray at very low level, scrape sparks, damage smoke &
// fire, start-up smoke puff and the landing-light beam.

import {
  AdditiveBlending, Color, CylinderGeometry, DoubleSide, Group, LatheGeometry, Mesh, NormalBlending, PlaneGeometry, Quaternion,
  ShaderMaterial, Vector2, Vector3, type Scene,
} from 'three';
import { ParticleSystem } from './Particles.ts';
import { Trail } from './Trails.ts';
import { CURVATURE_GLSL, FX_DEPTH_GLSL, fxDepth, globals } from '../render/Globals.ts';
import type { AircraftPhysics } from '../aircraft/AircraftPhysics.ts';
import { NOZZLE, WING } from '../aircraft/visual/FighterGeometry.ts';
import { clamp, damp, DEG, smoothstep } from '../core/math.ts';
import { events } from '../core/EventBus.ts';

const meshVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vViewZ;
varying vec3 vLocal;
${CURVATURE_GLSL}
void main() {
  vUv = uv;
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vec4 mv = viewMatrix * vec4(applyCurvature(wp.xyz), 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const flameFrag = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uIntensity;
uniform float uDiamonds;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uCore;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vViewZ;
${FX_DEPTH_GLSL}
void main() {
  if (vViewZ > sceneViewDepth(gl_FragCoord.xy) + 0.05) discard;
  float t = vUv.y;               // 0 = nozzle exit, 1 = tip
  float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.3);
  float n = texture2D(uNoiseTex, vec2(vUv.x * 1.0, t * 0.8 - uTime * 4.0)).r;
  float n2 = texture2D(uNoiseTex, vec2(vUv.x * 2.0 + 0.3, t * 1.6 - uTime * 7.0)).g;
  float body = pow(1.0 - t, 1.6) * (0.8 + 0.35 * n);
  // Mach / shock diamonds: bright periodic bands near the exit
  float dia = pow(0.5 + 0.5 * cos(t * uDiamonds * 6.2832), 10.0) * smoothstep(0.85, 0.05, t) * uCore;
  vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.7, t + (n2 - 0.5) * 0.2));
  vec3 c = col * (body * 2.0 + dia * 5.0) * rim * uIntensity * (0.9 + 0.2 * n2);
  c *= smoothstep(0.0, 0.04, t);
  gl_FragColor = vec4(c, 1.0);
}`;

const hazeFrag = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uStrength;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vViewZ;
${FX_DEPTH_GLSL}
void main() {
  if (vViewZ > sceneViewDepth(gl_FragCoord.xy)) discard;
  float t = vUv.y;
  float rim = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
  vec2 uv = vec2(vUv.x * 3.0, t * 2.0 - uTime * 3.5);
  float e = 0.02;
  float h0 = texture2D(uNoiseTex, uv).g;
  float hx = texture2D(uNoiseTex, uv + vec2(e, 0.0)).g;
  float hy = texture2D(uNoiseTex, uv + vec2(0.0, e)).g;
  vec2 grad = vec2(hx - h0, hy - h0) / e;
  float fall = (1.0 - t) * smoothstep(0.0, 0.08, t) * rim;
  // stronger near the viewer: distortion is an angular effect
  float dist = clamp(30.0 / max(vViewZ, 1.0), 0.15, 1.0);
  // real heat shimmer displaces the background by a few pixels at most
  vec2 off = grad * 0.0004 * uStrength * fall * dist;
  float l = length(off);
  if (l > 0.0035) off *= 0.0035 / l;
  gl_FragColor = vec4(off, 0.0, 1.0);
}`;

const mistFrag = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uAmount;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform float uMode; // 0 wing sheet, 1 vortex tube, 2 vapour cone
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vViewZ;
varying vec3 vLocal;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd) discard;
  float soft = clamp((sd - vViewZ) / 0.4, 0.0, 1.0);
  float rim = abs(dot(normalize(vN), normalize(vV)));
  float a;
  if (uMode < 0.5) {
    // sheet over the wing: densest just behind the leading edge, streaming aft
    float chord = vUv.y;
    float n = texture2D(uNoiseTex, vec2(vUv.x * 3.0, chord * 1.2 - uTime * 2.6)).r;
    float n2 = texture2D(uNoiseTex, vec2(vUv.x * 9.0, chord * 4.0 - uTime * 5.0)).a;
    a = smoothstep(0.0, 0.12, chord) * (1.0 - smoothstep(0.3, 0.9, chord)) * smoothstep(0.45, 0.85, n * 0.65 + n2 * 0.5) * (0.35 + 0.65 * n2);
  } else if (uMode < 1.5) {
    float n = texture2D(uNoiseTex, vec2(vUv.x * 2.0 + vUv.y * 3.0 - uTime * 4.0, vUv.y * 2.0 - uTime * 3.0)).r;
    a = (0.3 + 0.9 * n) * pow(rim, 0.7) * smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.4, 1.0, vUv.y));
  } else {
    float n = texture2D(uNoiseTex, vec2(vUv.x * 4.0, vUv.y * 2.0 - uTime * 1.5)).r;
    a = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.15, 1.0, vUv.y)) * (0.4 + 0.9 * n) * pow(1.0 - rim, 0.5);
  }
  a *= uAmount * soft;
  if (a < 0.004) discard;
  vec3 col = vec3(1.0) * (uSunColor * 0.32 + uSkyAmbient * 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

const beamFrag = /* glsl */ `
uniform float uAmount;
uniform sampler2D uNoiseTex;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vViewZ;
${FX_DEPTH_GLSL}
void main() {
  float sd = sceneViewDepth(gl_FragCoord.xy);
  if (vViewZ > sd) discard;
  float soft = clamp((sd - vViewZ) / 3.0, 0.0, 1.0);
  float rim = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
  float n = texture2D(uNoiseTex, vec2(vUv.x * 2.0, vUv.y * 3.0 - uTime * 0.2)).r;
  float a = rim * (1.0 - vUv.y) * (1.0 - vUv.y) * uAmount * soft * (0.7 + 0.5 * n);
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * a, 1.0);
}`;

function fxMat(frag: string, uniforms: Record<string, { value: unknown }>, additive: boolean, extra: Partial<ShaderMaterial> = {}): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader: meshVert,
    fragmentShader: frag,
    uniforms: { uNoiseTex: globals.uNoiseTex, uTime: globals.uTime, uCurvOrigin: globals.uCurvOrigin, uSunColor: globals.uSunColor, uSkyAmbient: globals.uSkyAmbient, ...fxDepth, ...uniforms },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    blending: additive ? AdditiveBlending : NormalBlending,
    premultipliedAlpha: true,
  });
  Object.assign(m, extra);
  return m;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();

export class AircraftEffects {
  /** follows the aircraft in the FX scene */
  readonly anchor = new Group();
  readonly hazeAnchor = new Group();
  readonly smoke = new ParticleSystem({ max: 900, additive: false, shape: 0, drag: 0.6, buoyancy: 0.6, lit: true });
  readonly fire = new ParticleSystem({ max: 300, additive: true, shape: 1, drag: 1.5, buoyancy: 3, lit: false });
  readonly sparks = new ParticleSystem({ max: 200, additive: true, shape: 2, drag: 0.5, buoyancy: -9, lit: false });
  readonly contrail: Trail;
  readonly vortexL: Trail;
  readonly vortexR: Trail;
  readonly smokeTrail: Trail;
  private flameOuter: Mesh;
  private flameCore: Mesh;
  private haze: Mesh;
  private wingMist: Mesh[] = [];
  private lerx: Mesh[] = [];
  private vaporCone: Mesh;
  private beam: Mesh;
  private time = 0;
  private emitAcc = { tire: 0, smoke: 0, dust: 0, fire: 0, spark: 0 };
  private startPuff = 0;
  wingVapor = 0;
  coneAmount = 0;

  constructor(fxScene: Scene, distortScene: Scene) {
    fxScene.add(this.anchor, this.smoke.mesh, this.fire.mesh, this.sparks.mesh);
    distortScene.add(this.hazeAnchor);
    // ---- afterburner flame (two nested cones along +z from the nozzle exit)
    const flameGeo = (r0: number, len: number) => {
      const g = new CylinderGeometry(r0, r0 * 0.22, len, 28, 24, true);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0, len / 2);
      // v = 0 at the nozzle
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      return g;
    };
    this.flameOuter = new Mesh(flameGeo(0.56, 1), fxMat(flameFrag, { uIntensity: { value: 0 }, uDiamonds: { value: 3.5 }, uColA: { value: new Color(1.0, 0.62, 0.32) }, uColB: { value: new Color(0.9, 0.3, 0.1) }, uCore: { value: 0.3 } }, true));
    this.flameCore = new Mesh(flameGeo(0.36, 1), fxMat(flameFrag, { uIntensity: { value: 0 }, uDiamonds: { value: 5.5 }, uColA: { value: new Color(0.55, 0.7, 1.0) }, uColB: { value: new Color(1.0, 0.75, 0.45) }, uCore: { value: 1.0 } }, true));
    for (const f of [this.flameOuter, this.flameCore]) {
      f.position.set(0, 0.08, NOZZLE.z0 + NOZZLE.length - 0.1);
      f.frustumCulled = false;
      this.anchor.add(f);
    }
    // ---- heat haze cone (distortion pass)
    const hazeGeo = new CylinderGeometry(0.5, 2.2, 1, 20, 12, true);
    hazeGeo.rotateX(-Math.PI / 2);
    hazeGeo.translate(0, 0, 0.5);
    const huv = hazeGeo.attributes.uv;
    for (let i = 0; i < huv.count; i++) huv.setY(i, 1 - huv.getY(i));
    this.haze = new Mesh(hazeGeo, fxMat(hazeFrag, { uStrength: { value: 0 } }, true));
    this.haze.position.set(0, 0.08, NOZZLE.z0 + NOZZLE.length);
    this.haze.frustumCulled = false;
    this.hazeAnchor.add(this.haze);
    // ---- condensation sheets over each wing (three stacked layers)
    for (const side of [1, -1]) {
      for (let layer = 0; layer < 3; layer++) {
        const span = WING.tipLE[0] - WING.rootLE[0];
        const g = new PlaneGeometry(1, 1, 8, 8);
        // map plane to the wing planform (u along span, v along chord)
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const u = p.getX(i) + 0.5, v = 0.5 - p.getY(i);
          const x = WING.rootLE[0] + span * u;
          const zLE = WING.rootLE[2] + (WING.tipLE[2] - WING.rootLE[2]) * u;
          const chord = WING.rootChord + (WING.tipChord - WING.rootChord) * u;
          p.setXYZ(i, side * x, 0.12 + layer * 0.09 + v * 0.05 - u * 0.12, zLE + chord * v * 0.85);
        }
        g.computeVertexNormals();
        const m = new Mesh(g, fxMat(mistFrag, { uAmount: { value: 0 }, uMode: { value: 0 } }, false));
        m.frustumCulled = false;
        this.anchor.add(m);
        this.wingMist.push(m);
      }
      // LERX vortex core tube
      const tube = new CylinderGeometry(0.06, 0.42, 1, 16, 12, true);
      tube.rotateX(-Math.PI / 2);
      tube.translate(0, 0, 0.5);
      const tuv = tube.attributes.uv;
      for (let i = 0; i < tuv.count; i++) tuv.setY(i, 1 - tuv.getY(i));
      const lm = new Mesh(tube, fxMat(mistFrag, { uAmount: { value: 0 }, uMode: { value: 1 } }, false));
      const a = new Vector3(side * 1.0, 0.32, -4.2), b = new Vector3(side * 2.9, 0.62, 3.8);
      lm.position.copy(a);
      lm.scale.set(1, 1, a.distanceTo(b));
      lm.frustumCulled = false;
      this.anchor.add(lm);
      this.lerx.push(lm);
    }
    // fix lookAt usage in local space: orient tubes manually
    for (const [i, side] of [[0, 1], [1, -1]] as const) {
      const a = new Vector3(side * 1.0, 0.32, -4.2), b = new Vector3(side * 2.9, 0.62, 3.8);
      const dir = b.clone().sub(a).normalize();
      this.lerx[i].quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
    }
    // ---- transonic vapour cone (bell-shaped shell around the aft fuselage)
    const pts: Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(new Vector2(1.0 + 2.4 * Math.pow(t, 0.6), t * 6));
    }
    const lathe = new LatheGeometry(pts, 40);
    lathe.rotateX(Math.PI / 2);
    this.vaporCone = new Mesh(lathe, fxMat(mistFrag, { uAmount: { value: 0 }, uMode: { value: 2 } }, false));
    this.vaporCone.position.set(0, 0.25, -3.2);
    this.vaporCone.frustumCulled = false;
    this.anchor.add(this.vaporCone);
    // ---- landing light beam
    const beamGeo = new CylinderGeometry(9, 0.08, 70, 24, 1, true);
    beamGeo.rotateX(-Math.PI / 2);
    beamGeo.translate(0, 0, -35);
    const buv = beamGeo.attributes.uv;
    for (let i = 0; i < buv.count; i++) buv.setY(i, buv.getY(i));
    this.beam = new Mesh(beamGeo, fxMat(beamFrag, { uAmount: { value: 0 } }, true));
    this.beam.position.set(0, -1.15, -5.3);
    this.beam.rotation.x = -0.05;
    this.beam.frustumCulled = false;
    this.anchor.add(this.beam);
    // ---- trails
    this.contrail = new Trail(220, 70, 0.8, 26, new Color(1, 1, 1), 0.75, 18);
    this.vortexL = new Trail(90, 2.4, 0.12, 0.7, new Color(1, 1, 1), 0.65, 4);
    this.vortexR = new Trail(90, 2.4, 0.12, 0.7, new Color(1, 1, 1), 0.65, 4);
    this.smokeTrail = new Trail(200, 25, 1.0, 9, new Color(0.18, 0.17, 0.16), 0.8, 10);
    fxScene.add(this.contrail.mesh, this.vortexL.mesh, this.vortexR.mesh, this.smokeTrail.mesh);
    events.on('engine:state', (e) => {
      if (e.state === 'LIGHTOFF') this.startPuff = 1.2;
    });
  }

  update(dt: number, ac: AircraftPhysics, pos: Vector3, quat: Quaternion, humidity: number, wind: Vector3, landingLight: number, fogAmount: number, waterBelow: boolean, groundHeight: number): void {
    this.time += dt;
    const t = ac.t;
    this.anchor.position.copy(pos);
    this.anchor.quaternion.copy(quat);
    this.hazeAnchor.position.copy(pos);
    this.hazeAnchor.quaternion.copy(quat);
    const e = ac.engine;
    const now = globals.uTime.value;
    // ---- afterburner flame: longer and wider at altitude (under-expanded plume)
    const ab = e.abFraction;
    const altK = 1 + clamp(ac.position.y / 12000, 0, 1) * 0.6;
    const flicker = 0.9 + 0.1 * Math.sin(this.time * 47) * Math.sin(this.time * 31);
    const lenO = (2.8 + 3.0 * ab) * altK * flicker;
    const lenC = (1.6 + 2.0 * ab) * altK;
    this.flameOuter.scale.set(1 + 0.25 * (altK - 1), 1 + 0.25 * (altK - 1), lenO);
    this.flameCore.scale.set(1, 1, lenC);
    (this.flameOuter.material as ShaderMaterial).uniforms.uIntensity.value = ab * 1.4;
    (this.flameCore.material as ShaderMaterial).uniforms.uIntensity.value = ab * 2.2;
    this.flameOuter.visible = this.flameCore.visible = ab > 0.01;
    // ---- heat haze: always present with the engine hot, strongest in AB
    const hot = clamp((e.egt - 200) / 600, 0, 1);
    const hazeLen = 8 + 18 * hot + 14 * ab;
    this.haze.scale.set(1 + ab * 0.6, 1 + ab * 0.6, hazeLen);
    (this.haze.material as ShaderMaterial).uniforms.uStrength.value = hot * (0.5 + 0.5 * clamp(e.n2, 0, 1)) + ab * 1.4;
    this.haze.visible = hot > 0.02;
    // ---- condensation physics proxy: humid air + low pressure over the wing (high CL / G) + low altitude
    const lowAlt = 1 - smoothstep(4000, 9000, ac.position.y);
    const cl = Math.max(0, ac.aero.liftCoefficientNorm);
    const qk = smoothstep(3500, 15000, t.qbar);
    const vaporTarget = clamp((humidity - 0.45) * 2.2, 0, 1) * lowAlt * qk * smoothstep(0.32, 0.75, cl * Math.min(1, t.nz / 4));
    this.wingVapor = damp(this.wingVapor, vaporTarget, vaporTarget > this.wingVapor ? 8 : 4, dt);
    for (const m of this.wingMist) {
      (m.material as ShaderMaterial).uniforms.uAmount.value = this.wingVapor * 0.32;
      m.visible = this.wingVapor > 0.01;
    }
    const lerxAmt = clamp((humidity - 0.35) * 2, 0, 1) * lowAlt * smoothstep(12 * DEG, 22 * DEG, t.alpha) * smoothstep(40, 90, t.tas);
    for (const m of this.lerx) {
      (m.material as ShaderMaterial).uniforms.uAmount.value = lerxAmt * 0.8;
      m.visible = lerxAmt > 0.01;
    }
    // ---- transonic vapour cone around Mach 0.97..1.03 in humid air
    const coneT = clamp((humidity - 0.3) * 1.8, 0, 1) * lowAlt * (smoothstep(0.93, 0.985, t.mach) * (1 - smoothstep(1.015, 1.08, t.mach)));
    this.coneAmount = damp(this.coneAmount, coneT, 6, dt);
    (this.vaporCone.material as ShaderMaterial).uniforms.uAmount.value = this.coneAmount * 0.9;
    this.vaporCone.visible = this.coneAmount > 0.01;
    // ---- wingtip vortices (condensation in the vortex core)
    const vortexStr = clamp((humidity - 0.4) * 2.5, 0, 1) * lowAlt * smoothstep(0.35, 0.8, cl) * smoothstep(60, 120, t.tas) * (t.onGround ? 0 : 1);
    for (const [trail, x] of [[this.vortexL, -5.35], [this.vortexR, 5.35]] as const) {
      _v.set(x, -0.15, 3.4).applyQuaternion(quat).add(pos);
      trail.push(_v, now, vortexStr);
    }
    // ---- contrail: cold, high, engine running (persistent, wide)
    const tempC = ac.atm.temperature - 273.15;
    const contrailStr = smoothstep(-38, -48, tempC) * (e.running ? 1 : 0) * smoothstep(7500, 9000, ac.position.y) * clamp(0.4 + humidity, 0, 1);
    _v.set(0, 0.08, NOZZLE.z0 + NOZZLE.length + 6).applyQuaternion(quat).add(pos);
    this.contrail.push(_v, now, contrailStr);
    // ---- damage smoke trail + fire particles
    const smokeAmt = ac.damage.smoke;
    this.smokeTrail.push(_v2.set(0, 0.1, 6.0).applyQuaternion(quat).add(pos), now, smokeAmt * (t.onGround && t.groundSpeed < 2 ? 0 : 1));
    // particles: velocity of the source point
    const vel = ac.velocity;
    this.emitAcc.smoke += dt * (smokeAmt * 30 + this.startPuff * 40);
    while (this.emitAcc.smoke >= 1) {
      this.emitAcc.smoke -= 1;
      _v.set((Math.random() - 0.5) * 0.6, 0.1 + (Math.random() - 0.5) * 0.6, NOZZLE.z0 + 0.8).applyQuaternion(quat).add(pos);
      const c = this.startPuff > 0 ? new Color(0.16, 0.15, 0.14) : new Color(0.12, 0.115, 0.11);
      this.smoke.emit(_v, _v2.copy(vel).multiplyScalar(0.3).add(new Vector3(0, 1.5, 0)), 0.8 + Math.random() * 0.6, 2.5, 4 + Math.random() * 3, c, this.startPuff > 0 ? 0.45 : 0.55 * smokeAmt);
    }
    this.startPuff = Math.max(0, this.startPuff - dt);
    this.emitAcc.fire += dt * ac.damage.fire * 60;
    while (this.emitAcc.fire >= 1) {
      this.emitAcc.fire -= 1;
      _v.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.3) * 0.6, 4.5 + Math.random() * 2.5).applyQuaternion(quat).add(pos);
      this.fire.emit(_v, _v2.copy(vel).multiplyScalar(0.85), 0.5 + Math.random() * 0.7, 1.2, 0.35 + Math.random() * 0.4, new Color(4.5, 1.6, 0.4), 0.9);
    }
    // ---- tyre smoke on spin-up / heavy braking
    for (const l of ac.gear.legs) {
      if (!l.contact || l.skid < 0.12) continue;
      const n = Math.ceil(l.skid * 6);
      for (let k = 0; k < n; k++) {
        _v.copy(l.contactPoint).add(new Vector3((Math.random() - 0.5) * 0.3, 0.25, (Math.random() - 0.5) * 0.3));
        this.smoke.emit(_v, _v2.copy(vel).multiplyScalar(0.25).add(new Vector3(0, 0.8, 0)), 0.5, 2.8, 2.5 + Math.random() * 2, new Color(0.85, 0.85, 0.85), 0.35 * l.skid);
      }
    }
    // ---- scrape sparks
    if (ac.scrapeIntensity > 0.05) {
      const n = Math.ceil(ac.scrapeIntensity * 12);
      for (let k = 0; k < n; k++) {
        _v.set((Math.random() - 0.5) * 1.5, -1.0, (Math.random() - 0.2) * 8).applyQuaternion(quat).add(pos);
        _v.y = Math.max(_v.y, groundHeight + 0.1);
        const sv = _v2.copy(vel).multiplyScalar(0.7).add(new Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6));
        this.sparks.emit(_v, sv, 0.06, 0, 0.3 + Math.random() * 0.4, new Color(6, 3, 1.2), 1, 6);
      }
    }
    // ---- low-level rooster tail: dust over land, spray over water
    const agl = t.agl;
    const lowFast = (1 - smoothstep(6, 35, agl)) * smoothstep(60, 160, t.tas) * (t.onGround ? 0 : 1);
    this.emitAcc.dust += dt * lowFast * 120;
    while (this.emitAcc.dust >= 1) {
      this.emitAcc.dust -= 1;
      _v.set((Math.random() - 0.5) * 6, 0, 4 + Math.random() * 14).applyQuaternion(quat).add(pos);
      _v.y = groundHeight + 0.4;
      const c = waterBelow ? new Color(0.9, 0.93, 0.95) : new Color(0.42, 0.36, 0.28);
      this.smoke.emit(_v, _v2.copy(vel).multiplyScalar(0.18).add(new Vector3(0, 3 + Math.random() * 4, 0)), 1.2, 4, 2 + Math.random() * 2, c, 0.35 * lowFast);
    }
    // ---- landing light beam (visible in haze / fog / night)
    const beamAmt = landingLight * clamp(0.04 + fogAmount * 0.4 + globals.uNight.value * 0.08, 0, 0.5);
    (this.beam.material as ShaderMaterial).uniforms.uAmount.value = beamAmt;
    this.beam.visible = beamAmt > 0.001;
    // ---- particles & trails tick
    this.smoke.update(dt, wind);
    this.fire.update(dt, wind);
    this.sparks.update(dt, new Vector3());
    for (const tr of [this.contrail, this.vortexL, this.vortexR, this.smokeTrail]) tr.tick(now);
    void _q;
  }

  explode(pos: Vector3): void {
    for (let i = 0; i < 80; i++) {
      const d = new Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      this.fire.emit(pos.clone().addScaledVector(d, Math.random() * 3), d.clone().multiplyScalar(8 + Math.random() * 20), 2 + Math.random() * 3, 4, 0.8 + Math.random() * 0.8, new Color(5, 2, 0.6), 1);
    }
    for (let i = 0; i < 60; i++) {
      const d = new Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      this.smoke.emit(pos.clone().addScaledVector(d, Math.random() * 4), d.clone().multiplyScalar(4 + Math.random() * 8), 3, 5, 8 + Math.random() * 6, new Color(0.08, 0.075, 0.07), 0.8);
    }
  }
}
