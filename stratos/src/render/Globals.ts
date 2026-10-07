// Shared uniform objects referenced by many materials. Updating `.value` here
// updates every material at once (no per-material bookkeeping).

import { Color, Vector3, Texture, Vector2 } from 'three';


export const EARTH_RADIUS = 6371000;

/** Render state flags known after renderer creation. */
export const renderState = { reversedDepth: true };

/**
 * polygonOffset values that pull geometry towards the camera for either depth
 * convention. three.js already negates the factor for reversed depth, but not
 * the units, so only the units are flipped here.
 */
export function decalOffset(factor: number, units: number): { polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number } {
  return { polygonOffset: true, polygonOffsetFactor: -Math.abs(factor), polygonOffsetUnits: (renderState.reversedDepth ? 1 : -1) * Math.abs(units) };
}

export const globals = {
  uTime: { value: 0 },
  uSunDir: { value: new Vector3(0.3, 0.8, -0.2).normalize() },
  uSunColor: { value: new Color(1, 1, 1) },
  uMoonDir: { value: new Vector3(-0.3, 0.6, 0.4).normalize() },
  /** camera position used as the earth-curvature origin */
  uCurvOrigin: { value: new Vector3() },
  uWetness: { value: 0 },
  uSnow: { value: 0 },
  /** 0 = day, 1 = full night (drives emissive city lights etc.) */
  uNight: { value: 0 },
  uNoiseTex: { value: null as Texture | null },
  uWind: { value: new Vector2(0, 0) },
  /** ambient sky radiance (for custom shaders that don't use env maps) */
  uSkyAmbient: { value: new Color(0.4, 0.5, 0.65) },
  uGroundAmbient: { value: new Color(0.25, 0.22, 0.18) },
  /** global emissive multiplier for artificial lights (cities / runway) */
  uLightsOn: { value: 0 },
  uLightningFlash: { value: 0 },
};

/** GLSL snippet: apply earth curvature to a view-space position given world matrix context. */
export const CURVATURE_GLSL = /* glsl */ `
uniform vec3 uCurvOrigin;
vec3 applyCurvature(vec3 worldPos) {
  vec2 d = worldPos.xz - uCurvOrigin.xz;
  float drop = dot(d, d) * ${(1 / (2 * EARTH_RADIUS)).toExponential(6)};
  worldPos.y -= drop;
  return worldPos;
}
`;

/** Uniforms shared with forward FX shaders for soft particles / manual depth test. */
export const fxDepth = {
  tSceneDepth: { value: null as Texture | null },
  uDepthParams: { value: new Vector3(0, 0, 1) }, // P10, P14, reversed
  uResolution: { value: new Vector2(1, 1) },
};

export const FX_DEPTH_GLSL = /* glsl */ `
uniform sampler2D tSceneDepth;
uniform vec3 uDepthParams;
uniform vec2 uResolution;
float sceneViewDepth(vec2 fragCoord) {
  float d = texture2D(tSceneDepth, fragCoord / uResolution).r;
  float ndc = uDepthParams.z > 0.5 ? d : d * 2.0 - 1.0;
  if (uDepthParams.z > 0.5 && d <= 0.0) return 1e9;
  if (uDepthParams.z < 0.5 && d >= 1.0) return 1e9;
  return uDepthParams.y / (ndc + uDepthParams.x);
}
`;
