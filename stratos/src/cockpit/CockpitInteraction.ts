// Look-at / cursor interaction with cockpit controls: raycast against control
// hit volumes, subtle highlight on hover, optional tooltip, click / wheel to
// operate (left = next, right = previous, wheel = rotate knobs).

import { Raycaster, Vector2, type Camera, type Object3D } from 'three';
import type { CockpitControl } from './CockpitControls.ts';

export class CockpitInteraction {
  private ray = new Raycaster();
  hovered: CockpitControl | null = null;
  enabled = true;
  showTooltips = true;
  private tooltipEl: HTMLDivElement;
  private reticle: HTMLDivElement;

  constructor(uiRoot: HTMLElement) {
    this.ray.far = 1.4;
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'ck-tooltip';
    uiRoot.appendChild(this.tooltipEl);
    this.reticle = document.createElement('div');
    this.reticle.className = 'ck-reticle';
    uiRoot.appendChild(this.reticle);
  }

  /**
   * @param ndc cursor position in normalised device coordinates (0,0 = gaze centre)
   */
  update(camera: Camera, targets: Object3D[], ndc: Vector2, gazeMode: boolean): void {
    if (this.hovered) this.hovered.hovered = false;
    this.hovered = null;
    if (!this.enabled) {
      this.tooltipEl.style.display = 'none';
      this.reticle.style.display = 'none';
      return;
    }
    this.ray.setFromCamera(ndc, camera);
    const hits = this.ray.intersectObjects(targets, false);
    if (hits.length) {
      const c = hits[0].object.userData.control as CockpitControl | undefined;
      if (c) {
        this.hovered = c;
        c.hovered = true;
      }
    }
    this.reticle.style.display = gazeMode ? 'block' : 'none';
    this.reticle.classList.toggle('active', !!this.hovered);
    if (this.hovered && this.showTooltips) {
      this.tooltipEl.style.display = 'block';
      this.tooltipEl.textContent = this.hovered.tooltip;
      const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
      this.tooltipEl.style.left = `${x + 18}px`;
      this.tooltipEl.style.top = `${y + 14}px`;
    } else this.tooltipEl.style.display = 'none';
  }

  click(dir = 1): boolean {
    if (!this.hovered) return false;
    this.hovered.activate(dir);
    return true;
  }

  hide(): void {
    this.tooltipEl.style.display = 'none';
    this.reticle.style.display = 'none';
  }
}
