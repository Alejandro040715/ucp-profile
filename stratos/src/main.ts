import './ui/base.css';
import { Game } from './core/Game.ts';
import { preloadTextures } from './assets/TextureLibrary.ts';

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
preloadTextures((done, total) => {
  if (status) status.textContent = `LOADING TEXTURES ${done}/${total}…`;
}).then(() => {
  if (status) status.textContent = 'PREPARING AIRFRAME, TEXTURES AND TERRAIN…';
  requestAnimationFrame(() => setTimeout(start, 30));
});
