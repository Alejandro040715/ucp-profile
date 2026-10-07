// Sky system: renders a small sky-view LUT every frame from the camera
// altitude (used for the background, aerial perspective and cloud ambient),
// and periodically rebuilds a prefiltered environment map for PBR lighting.

import {
  BackSide, Color, HalfFloatType, LinearFilter, Mesh, OrthographicCamera, PlaneGeometry, PMREMGenerator, RGBAFormat,
  Scene, ShaderMaterial, SphereGeometry, Vector3, WebGLRenderTarget, type WebGLRenderer, type Texture, ClampToEdgeWrapping, RepeatWrapping,
} from 'three';
import { ATMOSPHERE_GLSL } from './AtmosphereModel.ts';
import { globals } from '../render/Globals.ts';

export const SKY_LUT_GLSL = /* glsl */ `
vec2 skyLutUV(vec3 d) {
  float az = atan(d.x, -d.z) / (2.0 * PI) + 0.5;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return vec2(az, v);
}
`;

const lutVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const lutFrag = /* glsl */ `
precision highp float;
#define PI 3.141592653589793
varying vec2 vUv;
uniform vec3 uSunDir;
uniform float uCamH;
uniform float uMie;
${ATMOSPHERE_GLSL}
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float t = (vUv.y - 0.5) * 2.0;
  float el = sign(t) * t * t * 0.5 * PI;
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  vec3 tr;
  vec3 c = skyRadiance(uCamH, d, uSunDir, uMie, tr);
  gl_FragColor = vec4(c, 1.0);
}
`;

const envFrag = /* glsl */ `
precision highp float;
#define PI 3.141592653589793
varying vec3 vDir;
uniform sampler2D uSkyLut;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uGround;
uniform float uOvercast;
uniform vec3 uCloudColor;
${SKY_LUT_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 c = texture2D(uSkyLut, skyLutUV(vec3(d.x, max(d.y, 0.0), d.z))).rgb;
  // soft sun (no hard disk to avoid fireflies in the prefiltered map)
  float mu = max(dot(d, uSunDir), 0.0);
  c += uSunColor * pow(mu, 180.0) * 4.0 * (1.0 - uOvercast);
  // overcast: flatten towards a grey cloud dome
  c = mix(c, uCloudColor * (0.6 + 0.4 * max(d.y, 0.0)), uOvercast);
  // ground bounce for the lower hemisphere
  float below = smoothstep(0.02, -0.15, d.y);
  c = mix(c, uGround, below);
  gl_FragColor = vec4(c, 1.0);
}
`;

const envVert = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export class Sky {
  readonly lut: WebGLRenderTarget;
  private lutScene = new Scene();
  private lutCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lutMat: ShaderMaterial;
  private envScene = new Scene();
  private envMat: ShaderMaterial;
  private pmrem: PMREMGenerator;
  envTexture: Texture | null = null;
  private envRT: WebGLRenderTarget | null = null;
  private envTimer = 0;
  private lastEnvSun = new Vector3();
  private lastOvercast = -1;
  mieScale = 1;
  overcast = 0;
  readonly cloudColor = new Color(0.5, 0.52, 0.55);
  readonly groundColor = new Color(0.08, 0.08, 0.06);
  private renderer: WebGLRenderer;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.lut = new WebGLRenderTarget(256, 128, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
    this.lut.texture.minFilter = LinearFilter;
    this.lut.texture.magFilter = LinearFilter;
    this.lut.texture.wrapS = RepeatWrapping;
    this.lut.texture.wrapT = ClampToEdgeWrapping;
    this.lut.texture.generateMipmaps = false;
    this.lutMat = new ShaderMaterial({
      vertexShader: lutVert,
      fragmentShader: lutFrag,
      uniforms: { uSunDir: globals.uSunDir, uCamH: { value: 100 }, uMie: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.lutScene.add(new Mesh(new PlaneGeometry(2, 2), this.lutMat));
    this.envMat = new ShaderMaterial({
      vertexShader: envVert,
      fragmentShader: envFrag,
      side: BackSide,
      uniforms: {
        uSkyLut: { value: this.lut.texture },
        uSunDir: globals.uSunDir,
        uSunColor: globals.uSunColor,
        uGround: { value: this.groundColor },
        uOvercast: { value: 0 },
        uCloudColor: { value: this.cloudColor },
      },
      depthWrite: false,
    });
    this.envScene.add(new Mesh(new SphereGeometry(100, 32, 16), this.envMat));
    this.pmrem = new PMREMGenerator(renderer);
  }

  /** Render the LUT for the current camera altitude; rebuild env map when needed. */
  update(dt: number, camAltitude: number, force = false): void {
    this.lutMat.uniforms.uCamH.value = Math.max(1, camAltitude);
    this.lutMat.uniforms.uMie.value = this.mieScale;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.lut);
    r.render(this.lutScene, this.lutCam);
    r.setRenderTarget(prev);

    this.envTimer -= dt;
    const sun = globals.uSunDir.value;
    const moved = sun.distanceTo(this.lastEnvSun) > 0.01 || Math.abs(this.overcast - this.lastOvercast) > 0.03;
    if (force || (this.envTimer <= 0 && moved)) {
      this.envTimer = 1.0;
      this.lastEnvSun.copy(sun);
      this.lastOvercast = this.overcast;
      this.envMat.uniforms.uOvercast.value = this.overcast;
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
      this.envRT?.dispose();
      this.envRT = rt;
      this.envTexture = rt.texture;
    }
  }
}
