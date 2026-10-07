// Screen-space ambient occlusion (Alchemy-style obscurance) from the depth
// buffer alone, at half resolution. The world radius scales with distance so
// it covers both cockpit switches (~10 cm) and the airframe from a chase view
// (~1 m), and fades out on far terrain. Output: r = AO, g = view depth (for
// the bilateral blur / upsample).

export const aoFrag = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform float uProjScale; // proj[1][1]
uniform float uAspect;
uniform float uReversed;
uniform vec2 uTexel; // full-res texel
varying vec2 vUv;

float rawDepth(vec2 uv) { return texture2D(tDepth, uv).r; }
bool isSky(float d) { return uReversed > 0.5 ? d <= 0.0 : d >= 1.0; }
vec3 viewPos(vec2 uv, float d) {
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, uReversed > 0.5 ? max(d, 1e-7) : d * 2.0 - 1.0, 1.0);
  return vp.xyz / vp.w;
}
vec3 viewPosAt(vec2 uv) { return viewPos(uv, rawDepth(uv)); }

void main() {
  float d = rawDepth(vUv);
  if (isSky(d)) { gl_FragColor = vec4(1.0, 60000.0, 0.0, 1.0); return; } // half-float safe sentinel
  vec3 P = viewPos(vUv, d);
  float dist = -P.z;
  // normal from the flattest neighbour pair (avoids smearing across edges)
  vec3 pr = viewPosAt(vUv + vec2(uTexel.x, 0.0)), pl = viewPosAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pu = viewPosAt(vUv + vec2(0.0, uTexel.y)), pd = viewPosAt(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  float R = clamp(dist * 0.05, 0.08, 2.2);
  float projR = min(R * uProjScale / dist * 0.5, 0.1);
  float ang = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float sum = 0.0;
  const int NS = 12;
  for (int i = 0; i < NS; i++) {
    float t = (float(i) + 0.5) / float(NS);
    float a = ang + float(i) * 2.3999632;
    vec2 off = vec2(cos(a) / uAspect, sin(a)) * sqrt(t) * projR;
    vec2 suv = vUv + off;
    float sd = rawDepth(suv);
    if (isSky(sd)) continue;
    vec3 v = viewPos(suv, sd) - P;
    float vv = dot(v, v);
    float range = 1.0 - smoothstep(R * R, 4.0 * R * R, vv);
    sum += max(0.0, dot(v, N) - 0.01 * dist) / (vv + 0.02 * R * R) * range;
  }
  float ao = max(0.0, 1.0 - 2.0 * 0.55 * R * sum / float(NS));
  ao = pow(ao, 1.4);
  // fade on distant scenery (terrain relief is already in the lighting)
  ao = mix(ao, 1.0, smoothstep(250.0, 900.0, dist));
  gl_FragColor = vec4(ao, min(dist, 60000.0), 0.0, 1.0);
}
`;

/** separable depth-aware blur (direction in uDir, half-res texel units) */
export const aoBlurFrag = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).rg;
  if (c.g > 900.0) { gl_FragColor = vec4(1.0, c.g, 0.0, 1.0); return; }
  float tol = 0.03 * c.g + 0.05;
  float sum = c.r, wsum = 1.0;
  for (int i = 1; i <= 4; i++) {
    float g = exp(-float(i * i) / 10.0);
    for (int s = -1; s <= 1; s += 2) {
      vec2 o = texture2D(tAO, vUv + uDir * float(i * s)).rg;
      float w = g * exp(-abs(o.g - c.g) / tol);
      sum += o.r * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
}
`;
