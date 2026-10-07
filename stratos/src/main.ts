import './ui/base.css';
import { Game } from './core/Game.ts';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const boot = document.getElementById('boot');

// let the boot screen paint before the (synchronous) asset generation starts
requestAnimationFrame(() =>
  setTimeout(() => {
    try {
      const game = new Game(canvas, ui);
      (window as unknown as { game: Game }).game = game;
      game.start();
      boot?.remove();
    } catch (err) {
      console.error(err);
      if (boot) boot.lastElementChild!.textContent = `WEBGL2 INITIALISATION FAILED — ${(err as Error).message}`;
    }
  }, 30),
);
