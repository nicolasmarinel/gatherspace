import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { GameScene } from './scenes/GameScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#1a202c',
  dom: { createContainer: true },
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: [BootScene, LobbyScene, GameScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
  pixelArt: true,
  roundPixels: true
});

window.addEventListener('resize', () => {
  game.scale.resize(window.innerWidth, window.innerHeight);
});
