import Phaser from 'phaser';
import {
  isCustomAvatar, customAt, walkAnimKey, danceAnimKey, POSES, idleTextureArgs,
} from '../avatars.js';

export class RemotePlayer {
  constructor(scene, id, x, y, avatarIndex, name) {
    this.scene = scene;
    this.id = id;
    this.avatarIndex = avatarIndex ?? 0;
    this.name = name || 'Player';
    this.targetX = x;
    this.targetY = y;
    this.direction = 'down';
    this.isMoving = false;
    this.dancing = false;

    this._custom = isCustomAvatar(this.avatarIndex) && !!customAt(this.avatarIndex);
    // add.sprite (not image) so custom avatars can play animations
    this.sprite = scene.add.sprite(x, y, ...idleTextureArgs(this.avatarIndex));
    this.sprite.setDepth(4);

    this.nameTag = scene.add.text(x, y - 36, this.name, {
      fontSize: '11px', color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#1a202caa', padding: { x: 4, y: 2 }
    }).setOrigin(0.5).setDepth(4.1);
  }

  moveTo(x, y, direction, isMoving, dancing) {
    this.targetX = x;
    this.targetY = y;
    if (direction) this.direction = direction;
    this.isMoving = !!isMoving;
    this.dancing = !!dancing;
  }

  update(_delta) {
    // Smooth interpolation — catches up to server position
    const lerp = 0.2;
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, lerp);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, lerp);
    this.nameTag.setPosition(this.sprite.x, this.sprite.y - 36);
    this._applyPose();
  }

  _applyPose() {
    if (this._custom) {
      const i = this.avatarIndex;
      if (this.dancing) {
        this.sprite.play(danceAnimKey(i), true);
      } else if (this.isMoving) {
        this.sprite.play(walkAnimKey(i, this.direction), true);
      } else {
        this.sprite.stop();
        this.sprite.setFrame(POSES[this.direction].idle);
      }
    } else {
      this.sprite.setTexture(`avatar-${this.avatarIndex}-${this.direction}`);
    }
  }

  destroy() {
    this.sprite.destroy();
    this.nameTag.destroy();
  }
}
