// User settings + quality presets, persisted in localStorage when available.

export type Quality = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';

export interface QualityPreset {
  renderScale: number;
  msaa: number;
  shadowMapSize: number;
  cloudScale: number;
  cloudSteps: number;
  lodFactor: number;
  treeDensity: number;
  treeRadius: number;
  farTreeRadius: number;
  grass: boolean;
  bloom: boolean;
  workers: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  LOW: { renderScale: 0.75, msaa: 0, shadowMapSize: 1024, cloudScale: 0.33, cloudSteps: 40, lodFactor: 1.4, treeDensity: 0.45, treeRadius: 700, farTreeRadius: 3500, grass: false, bloom: true, workers: 2 },
  MEDIUM: { renderScale: 0.9, msaa: 2, shadowMapSize: 2048, cloudScale: 0.4, cloudSteps: 56, lodFactor: 1.7, treeDensity: 0.7, treeRadius: 1000, farTreeRadius: 5000, grass: true, bloom: true, workers: 3 },
  HIGH: { renderScale: 1.0, msaa: 4, shadowMapSize: 2048, cloudScale: 0.5, cloudSteps: 72, lodFactor: 2.0, treeDensity: 1.0, treeRadius: 1300, farTreeRadius: 7000, grass: true, bloom: true, workers: 4 },
  ULTRA: { renderScale: 1.0, msaa: 4, shadowMapSize: 4096, cloudScale: 0.5, cloudSteps: 96, lodFactor: 2.5, treeDensity: 1.25, treeRadius: 1700, farTreeRadius: 9000, grass: true, bloom: true, workers: 4 },
};

export interface UserSettings {
  quality: Quality;
  invertPitch: boolean;
  mouseSensitivity: number;
  fov: number;
  masterVolume: number;
  fuelBurn: number;
  cameraShake: number;
  motionBlur: number;
  units: 'imperial' | 'metric';
  hudColor: 'green' | 'amber';
  showFps: boolean;
}

const DEFAULTS: UserSettings = {
  quality: 'HIGH',
  invertPitch: false,
  mouseSensitivity: 1,
  fov: 72,
  masterVolume: 0.8,
  fuelBurn: 1,
  cameraShake: 1,
  motionBlur: 0.0,
  units: 'imperial',
  hudColor: 'green',
  showFps: false,
};

const KEY = 'stratos.settings.v1';

export function loadSettings(): UserSettings {
  let s: UserSettings = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UserSettings>) };
  } catch {
    /* storage unavailable */
  }
  // URL override, e.g. ?q=LOW (used by automated tests)
  try {
    const q = new URLSearchParams(location.search).get('q')?.toUpperCase();
    if (q && q in QUALITY_PRESETS) s.quality = q as Quality;
  } catch {
    /* no location */
  }
  return s;
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
