// Frame graph:
//   main opaque (HDR, MSAA, reversed-Z depth) -> volumetric clouds (low res,
//   temporal) -> composite (sky, aerial perspective, fog, clouds) -> forward
//   transparent FX (soft particles, manual depth test) -> heat distortion ->
//   DoF / motion blur (optional) -> bloom -> final (lens, G-effects, ACES).

import {
  DepthTexture, FloatType, HalfFloatType, LinearFilter, Matrix4, NearestFilter, RGBAFormat, RGFormat, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
  type PerspectiveCamera, type Scene, type Texture, Color, UnsignedIntType, NoToneMapping, LinearSRGBColorSpace,
} from 'three';
import { FullscreenPass } from './FullscreenPass.ts';
import { compositeFrag } from './shaders/composite.ts';
import { downsampleFrag, upsampleFrag, finalFrag, dofMotionFrag } from './shaders/post.ts';
import { aoFrag, aoBlurFrag } from './shaders/ao.ts';
import { globals, renderState } from './Globals.ts';
import type { CloudRenderer } from '../atmosphere/CloudRenderer.ts';

export { fxDepth, FX_DEPTH_GLSL } from './Globals.ts';
import { fxDepth } from './Globals.ts';

export interface FrameParams {
  exposure: number;
  bloom: number;
  vignette: number;
  grain: number;
  saturation: number;
  contrast: number;
  tint: Color;
  chroma: number;
  gPos: number;
  gNeg: number;
  gGray: number;
  sunScreen: Vector3;
  fade: number;
  heat: number;
  // composite
  mie: number;
  fogDensity: number;
  fogBase: number;
  fogHeight: number;
  fogColor: Color;
  overcast: number;
  overcastColor: Color;
  flash: number;
  moonPhase: number;
  sunVisible: number;
  // photo
  camCloud: number;
  cloudFogColor: Color;
  dof: boolean;
  focus: number;
  aperture: number;
  focal: number;
  motion: number;
  /** ambient occlusion strength (0 = off) */
  ao: number;
}

export function defaultFrameParams(): FrameParams {
  return {
    exposure: 1, bloom: 0.04, vignette: 0.25, grain: 0.012, saturation: 1.05, contrast: 1.0, tint: new Color(1, 1, 1), chroma: 0.004,
    gPos: 0, gNeg: 0, gGray: 0, sunScreen: new Vector3(), fade: 0, heat: 1,
    mie: 1, fogDensity: 0, fogBase: 0, fogHeight: 300, fogColor: new Color(0.5, 0.55, 0.6), overcast: 0, overcastColor: new Color(0.5, 0.52, 0.55),
    flash: 0, moonPhase: 0.8, sunVisible: 1, camCloud: 0, cloudFogColor: new Color(0.5, 0.5, 0.5),
    dof: false, focus: 50, aperture: 2.8, focal: 50, motion: 0, ao: 1,
  };
}

export class RenderPipeline {
  readonly renderer: WebGLRenderer;
  readonly reversed: boolean;
  rtMain!: WebGLRenderTarget;
  rtHDR!: WebGLRenderTarget;
  rtPost!: WebGLRenderTarget;
  rtDistort!: WebGLRenderTarget;
  rtAO!: WebGLRenderTarget;
  rtAO2!: WebGLRenderTarget;
  private aoPass: FullscreenPass;
  private aoBlur: FullscreenPass;
  private bloomMips: WebGLRenderTarget[] = [];
  private composite: FullscreenPass;
  private down: FullscreenPass;
  private up: FullscreenPass;
  private final: FullscreenPass;
  private dofMotion: FullscreenPass;
  clouds: CloudRenderer | null = null;
  skyLut: Texture | null = null;
  renderScale = 1;
  msaa = 4;
  width = 1;
  height = 1;
  private prevViewProj = new Matrix4();
  private tmpVP = new Matrix4();
  readonly params = defaultFrameParams();
  /** stats */
  lastCalls = 0;
  lastTriangles = 0;

  constructor(canvas: HTMLCanvasElement) {
    let renderer: WebGLRenderer;
    const opts = { canvas, antialias: false, powerPreference: 'high-performance' as const, stencil: false, depth: true, alpha: false, reversedDepthBuffer: true, preserveDrawingBuffer: false };
    renderer = new WebGLRenderer(opts);
    this.renderer = renderer;
    this.reversed = renderer.capabilities.reversedDepthBuffer === true;
    renderState.reversedDepth = this.reversed;
    if (!this.reversed) console.warn('EXT_clip_control unavailable: using standard depth');
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = LinearSRGBColorSpace; // final pass does sRGB itself
    renderer.shadowMap.enabled = true;
    renderer.autoClear = true;
    renderer.info.autoReset = false;

    this.composite = new FullscreenPass(compositeFrag, {
      tScene: { value: null },
      tDepth: { value: null },
      tClouds: { value: null },
      tCloudDepth: { value: null },
      uCamCloud: { value: 0 },
      uCloudFogColor: { value: new Color(0.5, 0.5, 0.5) },
      uSkyLut: { value: null },
      uInvProj: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uReversed: { value: this.reversed ? 1 : 0 },
      uSunDir: globals.uSunDir,
      uSunColor: globals.uSunColor,
      uMoonDir: globals.uMoonDir,
      uMoonPhase: { value: 0.8 },
      uTime: globals.uTime,
      uNight: globals.uNight,
      uMie: { value: 1 },
      uFogDensity: { value: 0 },
      uFogBase: { value: 0 },
      uFogHeight: { value: 300 },
      uFogColor: { value: new Color() },
      uCloudsOn: { value: 1 },
      uOvercast: { value: 0 },
      uOvercastColor: { value: new Color() },
      uFlash: { value: 0 },
      uSunVisible: { value: 1 },
      tAO: { value: null },
      uAOTexel: { value: new Vector2() },
      uAOStrength: { value: 1 },
    });
    this.aoPass = new FullscreenPass(aoFrag, {
      tDepth: { value: null }, uInvProj: { value: new Matrix4() }, uProjScale: { value: 1 }, uAspect: { value: 1 },
      uReversed: { value: this.reversed ? 1 : 0 }, uTexel: { value: new Vector2() },
    });
    this.aoBlur = new FullscreenPass(aoBlurFrag, { tAO: { value: null }, uDir: { value: new Vector2() } });
    this.down = new FullscreenPass(downsampleFrag, { tSrc: { value: null }, uTexel: { value: new Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 0 } });
    this.up = new FullscreenPass(upsampleFrag, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 1 } });
    this.dofMotion = new FullscreenPass(dofMotionFrag, {
      tSrc: { value: null }, tDepth: { value: null }, uInvProj: { value: new Matrix4() }, uCamWorld: { value: new Matrix4() },
      uPrevViewProj: { value: new Matrix4() }, uCamPos: { value: new Vector3() }, uReversed: { value: this.reversed ? 1 : 0 },
      uFocus: { value: 50 }, uAperture: { value: 2.8 }, uFocal: { value: 50 }, uDofOn: { value: 0 }, uMotion: { value: 0 },
      uTexel: { value: new Vector2() }, uAspect: { value: 1 },
    });
    this.final = new FullscreenPass(finalFrag, {
      tSrc: { value: null }, tBloom: { value: null }, tDistort: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0.05 }, uVignette: { value: 0.3 }, uGrain: { value: 0.015 }, uTime: globals.uTime,
      uSaturation: { value: 1 }, uContrast: { value: 1 }, uTint: { value: new Color(1, 1, 1) }, uChroma: { value: 0.004 },
      uGPos: { value: 0 }, uGNeg: { value: 0 }, uGray: { value: 0 }, uSunScreen: { value: new Vector3() }, uAspect: { value: 1 },
      uWetLens: { value: 0 }, uFade: { value: 0 }, uHeat: { value: 1 },
      tDepth: { value: null }, uReversed: { value: this.reversed ? 1 : 0 },
    });
    this.allocate(1, 1);
  }

  private allocate(w: number, h: number): void {
    this.rtMain?.dispose();
    this.rtHDR?.dispose();
    this.rtPost?.dispose();
    this.rtDistort?.dispose();
    this.rtAO?.dispose();
    this.rtAO2?.dispose();
    for (const m of this.bloomMips) m.dispose();
    const depth = new DepthTexture(w, h, this.reversed ? FloatType : UnsignedIntType);
    depth.minFilter = depth.magFilter = NearestFilter;
    this.rtMain = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, samples: this.msaa, depthTexture: depth, depthBuffer: true, stencilBuffer: false });
    this.rtMain.texture.minFilter = this.rtMain.texture.magFilter = LinearFilter;
    this.rtMain.texture.generateMipmaps = false;
    this.rtHDR = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
    this.rtPost = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
    this.rtDistort = new WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
    const aw = Math.max(1, w >> 1), ah = Math.max(1, h >> 1);
    const aoOpts = { type: HalfFloatType, format: RGFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } as const;
    this.rtAO = new WebGLRenderTarget(aw, ah, aoOpts);
    this.rtAO2 = new WebGLRenderTarget(aw, ah, aoOpts);
    this.bloomMips = [];
    let bw = w, bh = h;
    for (let i = 0; i < 6; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      const rt = new WebGLRenderTarget(bw, bh, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
      rt.texture.minFilter = rt.texture.magFilter = LinearFilter;
      this.bloomMips.push(rt);
    }
    fxDepth.tSceneDepth.value = depth;
    fxDepth.uResolution.value.set(w, h);
  }

  setSize(cssW: number, cssH: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(1);
    const w = Math.max(1, Math.floor(cssW * pixelRatio * this.renderScale));
    const h = Math.max(1, Math.floor(cssH * pixelRatio * this.renderScale));
    this.renderer.setSize(Math.floor(cssW * pixelRatio), Math.floor(cssH * pixelRatio), false);
    (this.renderer.domElement as HTMLCanvasElement).style.width = cssW + 'px';
    (this.renderer.domElement as HTMLCanvasElement).style.height = cssH + 'px';
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.allocate(w, h);
    }
    this.clouds?.setSize(w, h);
  }

  render(scene: Scene, fxScene: Scene, distortScene: Scene, camera: PerspectiveCamera): void {
    const r = this.renderer;
    const p = this.params;
    r.info.reset();
    camera.updateMatrixWorld();
    const camPos = new Vector3().setFromMatrixPosition(camera.matrixWorld);

    // depth params for FX (P10, P14) — projection is already reversed by three when enabled
    const pe = camera.projectionMatrix.elements;
    fxDepth.uDepthParams.value.set(pe[10], pe[14], this.reversed ? 1 : 0);

    // 1. main opaque + aircraft + cockpit
    r.setRenderTarget(this.rtMain);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);
    // ensure the reversed projection (three flips it lazily on first render)
    fxDepth.uDepthParams.value.set(camera.projectionMatrix.elements[10], camera.projectionMatrix.elements[14], this.reversed ? 1 : 0);
    const depthTex = this.rtMain.depthTexture!;

    // 2. clouds
    if (this.clouds && this.clouds.enabled) this.clouds.render(r, depthTex, camera, camPos, this.reversed);

    // 2b. ambient occlusion (half res) + separable bilateral blur
    const cu = this.composite.uniforms;
    if (p.ao > 0) {
      const au = this.aoPass.uniforms;
      au.tDepth.value = depthTex;
      au.uInvProj.value.copy(camera.projectionMatrixInverse);
      au.uProjScale.value = camera.projectionMatrix.elements[5];
      au.uAspect.value = this.width / this.height;
      au.uTexel.value.set(1 / this.width, 1 / this.height);
      this.aoPass.render(r, this.rtAO);
      const bu = this.aoBlur.uniforms;
      bu.tAO.value = this.rtAO.texture;
      bu.uDir.value.set(1 / this.rtAO.width, 0);
      this.aoBlur.render(r, this.rtAO2);
      bu.tAO.value = this.rtAO2.texture;
      bu.uDir.value.set(0, 1 / this.rtAO.height);
      this.aoBlur.render(r, this.rtAO);
      cu.tAO.value = this.rtAO.texture;
      cu.uAOTexel.value.set(1 / this.rtAO.width, 1 / this.rtAO.height);
    }
    cu.uAOStrength.value = p.ao;

    // 3. composite
    cu.tScene.value = this.rtMain.texture;
    cu.tDepth.value = depthTex;
    cu.tClouds.value = this.clouds?.output ?? null;
    cu.tCloudDepth.value = this.clouds?.depthOutput ?? null;
    cu.uCamCloud.value = p.camCloud;
    cu.uCloudFogColor.value.copy(p.cloudFogColor);
    cu.uCloudsOn.value = this.clouds && this.clouds.enabled ? 1 : 0;
    cu.uSkyLut.value = this.skyLut;
    cu.uInvProj.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld.value.copy(camera.matrixWorld);
    cu.uCamPos.value.copy(camPos);
    cu.uMie.value = p.mie;
    cu.uFogDensity.value = p.fogDensity;
    cu.uFogBase.value = p.fogBase;
    cu.uFogHeight.value = p.fogHeight;
    cu.uFogColor.value.copy(p.fogColor);
    cu.uOvercast.value = p.overcast;
    cu.uOvercastColor.value.copy(p.overcastColor);
    cu.uFlash.value = p.flash;
    cu.uMoonPhase.value = p.moonPhase;
    cu.uSunVisible.value = p.sunVisible;
    this.composite.render(r, this.rtHDR);

    // 4. forward transparent effects (manual depth test against the resolved depth)
    r.setRenderTarget(this.rtHDR);
    r.autoClear = false;
    r.render(fxScene, camera);
    // 5. heat distortion vectors
    r.setRenderTarget(this.rtDistort);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(distortScene, camera);
    r.autoClear = true;

    // 6. DoF / motion blur
    let src: Texture = this.rtHDR.texture;
    if (p.dof || p.motion > 0) {
      const du = this.dofMotion.uniforms;
      du.tSrc.value = this.rtHDR.texture;
      du.tDepth.value = depthTex;
      du.uInvProj.value.copy(camera.projectionMatrixInverse);
      du.uCamWorld.value.copy(camera.matrixWorld);
      du.uPrevViewProj.value.copy(this.prevViewProj);
      du.uDofOn.value = p.dof ? 1 : 0;
      du.uFocus.value = p.focus;
      du.uAperture.value = p.aperture;
      du.uFocal.value = p.focal;
      du.uMotion.value = p.motion;
      du.uTexel.value.set(1 / this.width, 1 / this.height);
      du.uAspect.value = this.width / this.height;
      this.dofMotion.render(r, this.rtPost);
      src = this.rtPost.texture;
    }
    this.tmpVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.prevViewProj.copy(this.tmpVP);

    // 7. bloom chain
    let prevTex: Texture = src;
    let pw = this.width, ph = this.height;
    for (let i = 0; i < this.bloomMips.length; i++) {
      const d = this.down.uniforms;
      d.tSrc.value = prevTex;
      d.uTexel.value.set(1 / pw, 1 / ph);
      d.uFirst.value = i === 0 ? 1 : 0;
      d.uThreshold.value = 0.0;
      this.down.render(r, this.bloomMips[i]);
      prevTex = this.bloomMips[i].texture;
      pw = this.bloomMips[i].width;
      ph = this.bloomMips[i].height;
    }
    // upsample (accumulate into the larger mips; reuse mips in place via ping on the next larger)
    for (let i = this.bloomMips.length - 1; i > 0; i--) {
      const u = this.up.uniforms;
      u.tSrc.value = this.bloomMips[i].texture;
      u.tBase.value = this.bloomMips[i - 1].texture;
      u.uTexel.value.set(1 / this.bloomMips[i].width, 1 / this.bloomMips[i].height);
      // render into a scratch: rtPost is free if DoF wasn't used; otherwise reuse mips trick
      this.up.render(r, this.bloomScratch(i - 1));
      this.swapBloom(i - 1);
    }

    // 8. final
    const f = this.final.uniforms;
    f.tSrc.value = src;
    f.tBloom.value = this.bloomMips[0].texture;
    f.tDistort.value = this.rtDistort.texture;
    f.tDepth.value = depthTex;
    f.uExposure.value = p.exposure;
    f.uBloom.value = p.bloom;
    f.uVignette.value = p.vignette;
    f.uGrain.value = p.grain;
    f.uSaturation.value = p.saturation;
    f.uContrast.value = p.contrast;
    f.uTint.value.copy(p.tint);
    f.uChroma.value = p.chroma;
    f.uGPos.value = p.gPos;
    f.uGNeg.value = p.gNeg;
    f.uGray.value = p.gGray;
    f.uSunScreen.value.copy(p.sunScreen);
    f.uAspect.value = this.width / this.height;
    f.uFade.value = p.fade;
    f.uHeat.value = p.heat;
    this.final.render(r, null);
    this.lastCalls = r.info.render.calls;
    this.lastTriangles = r.info.render.triangles;
  }

  // bloom upsampling needs a destination different from its inputs
  private scratch: WebGLRenderTarget[] = [];
  private bloomScratch(i: number): WebGLRenderTarget {
    const m = this.bloomMips[i];
    let s = this.scratch[i];
    if (!s || s.width !== m.width || s.height !== m.height) {
      s?.dispose();
      s = new WebGLRenderTarget(m.width, m.height, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
      s.texture.minFilter = s.texture.magFilter = LinearFilter;
      this.scratch[i] = s;
    }
    return s;
  }
  private swapBloom(i: number): void {
    const t = this.bloomMips[i];
    this.bloomMips[i] = this.scratch[i];
    this.scratch[i] = t;
  }
}
