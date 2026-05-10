import Phaser from 'phaser';
import { AVATAR_COLORS } from '../constants.js';

export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    this.makeFloor();
    this.makeWall();
    this.makeDesk();
    this.makeChair();
    this.makePlant();
    this.makeSofa();
    this.makeTable();
    this.makeRug();
    this.makeAvatars();
    this.scene.start('Lobby');
  }

  // ── textures ──────────────────────────────────────────────────────────────

  makeFloor() {
    const g = this.add.graphics();
    g.fillStyle(0xf0ebe0); g.fillRect(0, 0, 64, 64);
    g.lineStyle(1, 0xddd5c5, 0.6); g.strokeRect(0, 0, 64, 64);
    g.generateTexture('floor', 64, 64); g.destroy();

    const w = this.add.graphics();
    w.fillStyle(0xdeb887); w.fillRect(0, 0, 64, 64);
    w.fillStyle(0xd4a873, 0.4);
    for (let y = 0; y < 64; y += 16) { w.fillRect(0, y, 64, 2); }
    w.generateTexture('floor-wood', 64, 64); w.destroy();
  }

  makeWall() {
    const g = this.add.graphics();
    g.fillStyle(0x374151); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x4b5563); g.fillRect(2, 2, 28, 28);
    g.generateTexture('wall', 32, 32); g.destroy();
  }

  makeDesk() {
    const g = this.add.graphics();
    g.fillStyle(0x7c5a2a); g.fillRect(0, 0, 96, 56);
    g.fillStyle(0x9a7040); g.fillRect(2, 2, 92, 16);
    // monitor
    g.fillStyle(0x1f2937); g.fillRect(28, 4, 40, 24);
    g.fillStyle(0x60a5fa); g.fillRect(30, 6, 36, 20);
    g.fillStyle(0x1f2937); g.fillRect(44, 28, 8, 5);
    g.generateTexture('desk', 96, 56); g.destroy();
  }

  makeChair() {
    const g = this.add.graphics();
    g.fillStyle(0x1e4080); g.fillRect(4, 6, 28, 8);   // back
    g.fillStyle(0x2563b0); g.fillRect(4, 14, 28, 24);  // seat
    g.fillStyle(0x6b7280); g.fillRect(6, 38, 4, 6); g.fillRect(26, 38, 4, 6); // legs
    g.generateTexture('chair', 36, 44); g.destroy();
  }

  makePlant() {
    const g = this.add.graphics();
    g.fillStyle(0x8b4513); g.fillRect(10, 30, 16, 14); // pot
    g.fillStyle(0x3d2b1f); g.fillRect(11, 30, 14, 5);  // soil
    g.fillStyle(0x1a5c36); g.fillCircle(18, 22, 11);
    g.fillStyle(0x27864f); g.fillCircle(11, 24, 8); g.fillCircle(25, 24, 8);
    g.fillStyle(0x38a169); g.fillCircle(18, 16, 7);
    g.generateTexture('plant', 36, 44); g.destroy();
  }

  makeSofa() {
    const g = this.add.graphics();
    g.fillStyle(0x4a5c99); g.fillRect(0, 0, 128, 56);  // body
    g.fillStyle(0x3a4c89); g.fillRect(0, 0, 128, 18);  // back
    g.fillStyle(0x3a4c89); g.fillRect(0, 0, 14, 56); g.fillRect(114, 0, 14, 56); // arms
    g.fillStyle(0x5a6ca9); g.fillRect(16, 20, 42, 32); g.fillRect(70, 20, 42, 32); // cushions
    g.lineStyle(1, 0x4a5c99, 0.5);
    g.strokeRect(16, 20, 42, 32); g.strokeRect(70, 20, 42, 32);
    g.generateTexture('sofa', 128, 56); g.destroy();
  }

  makeTable() {
    const g = this.add.graphics();
    g.fillStyle(0xb8964a); g.fillRect(0, 0, 160, 72);
    g.fillStyle(0xc8a85a); g.fillRect(4, 4, 152, 64);
    g.lineStyle(2, 0xd8b86a, 0.7); g.strokeRect(8, 8, 144, 56);
    g.generateTexture('table', 160, 72); g.destroy();
  }

  makeRug() {
    const g = this.add.graphics();
    g.fillStyle(0x7b1d2c); g.fillRect(0, 0, 192, 128);
    g.fillStyle(0x9b2d3c); g.fillRect(8, 8, 176, 112);
    g.lineStyle(2, 0xbc3d4c, 0.7); g.strokeRect(16, 16, 160, 96);
    g.lineStyle(1, 0xbc3d4c, 0.4); g.strokeRect(24, 24, 144, 80);
    g.generateTexture('rug', 192, 128); g.destroy();
  }

  makeAvatars() {
    AVATAR_COLORS.forEach((color, i) => {
      ['down', 'up', 'left', 'right'].forEach(dir => {
        const g = this.add.graphics();
        const W = 32, H = 48;

        // Shadow
        g.fillStyle(0x000000, 0.18);
        g.fillEllipse(W / 2, H - 3, 18, 7);

        // Body / shirt
        g.fillStyle(color.body);
        g.fillRect(9, 22, 14, 18);

        // Arms
        g.fillStyle(color.dark);
        if (dir === 'left') {
          g.fillRect(2, 23, 8, 12);
        } else if (dir === 'right') {
          g.fillRect(22, 23, 8, 12);
        } else {
          g.fillRect(2, 23, 8, 12);
          g.fillRect(22, 23, 8, 12);
        }

        // Legs
        g.fillStyle(0x334155);
        g.fillRect(9, 38, 6, 8);
        g.fillRect(17, 38, 6, 8);

        // Shoes
        g.fillStyle(0x1e293b);
        g.fillRect(8, 44, 7, 4);
        g.fillRect(17, 44, 7, 4);

        // Head (skin tone)
        g.fillStyle(0xfde68a);
        g.fillCircle(W / 2, 13, 10);

        // Hair
        g.fillStyle(color.dark);
        g.fillRect(6, 4, 20, 9);
        g.fillCircle(W / 2, 8, 10);

        // Face features
        if (dir !== 'up') {
          g.fillStyle(0x1a202c);
          if (dir === 'right') {
            g.fillRect(20, 12, 3, 3);
            // mouth
            g.fillRect(19, 17, 5, 2);
          } else if (dir === 'left') {
            g.fillRect(9, 12, 3, 3);
            g.fillRect(8, 17, 5, 2);
          } else {
            // down — facing camera
            g.fillRect(9, 12, 4, 3);
            g.fillRect(19, 12, 4, 3);
            g.fillRect(11, 18, 10, 2);
          }
        }

        g.generateTexture(`avatar-${i}-${dir}`, W, H);
        g.destroy();
      });
    });
  }
}
