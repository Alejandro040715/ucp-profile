// Minimal full-screen triangle pass helper.

import { BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera, ShaderMaterial, type WebGLRenderer, type WebGLRenderTarget, type IUniform } from 'three';

const tri = new BufferGeometry();
tri.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
tri.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class FullscreenPass {
  readonly material: ShaderMaterial;
  private mesh: Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, IUniform>, defines: Record<string, string | number> = {}) {
    this.material = new ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(tri, this.material);
    this.mesh.frustumCulled = false;
  }

  get uniforms(): Record<string, IUniform> {
    return this.material.uniforms;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, cam);
  }
}
