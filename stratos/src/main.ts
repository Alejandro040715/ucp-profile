import './ui/base.css';
import { Game } from './core/Game.ts';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const game = new Game(canvas, ui);
(window as unknown as { game: Game }).game = game;
game.start();
