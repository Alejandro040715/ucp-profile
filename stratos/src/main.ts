import './ui/base.css';
import { Game } from './core/Game.ts';
import { preloadTextures } from './assets/TextureLibrary.ts';
import { preloadF16Cockpit } from './cockpit/F16Cockpit.ts';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const boot = document.getElementById('boot');
const status = boot?.lastElementChild as HTMLElement | null;

function start(): void {
  try {
    const game = new Game(canvas, ui);
    (window as unknown as { game: Game }).game = game;
    game.start();
    boot?.remove();
  } catch (err) {
    console.error(err);
    if (status) status.textContent = `WEBGL2 INITIALISATION FAILED — ${(err as Error).message}`;
  }
}

// real textures first (progress on the boot screen), then the synchronous
// asset generation once the boot screen has painted
let texDone = 0, texTotal = 0, pitFrac = 0;
const progress = () => {
  if (status) status.textContent = `LOADING TEXTURES ${texDone}/${texTotal} · COCKPIT ${Math.round(pitFrac * 100)}%…`;
};
Promise.all([
  preloadTextures((done, total) => {
    texDone = done;
    texTotal = total;
    progress();
  }),
  preloadF16Cockpit((f) => {
    pitFrac = f;
    progress();
  }),
]).then(() => {
  if (status) status.textContent = 'PREPARING AIRFRAME, TEXTURES AND TERRAIN…';
  requestAnimationFrame(() => setTimeout(start, 30));
});
