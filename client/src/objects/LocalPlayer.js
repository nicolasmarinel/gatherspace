import { PLAYER_SPEED } from '../constants.js';
import {
  isCustomAvatar, customAt, sheetKey, walkAnimKey, danceAnimKey, POSES, idleTextureArgs,
} from '../avatars.js';

export class LocalPlayer {
  constructor(scene, x, y, avatarIndex, name) {
    this.scene = scene;
    this.avatarIndex = avatarIndex;
    this.name = name;
    this.direction = 'down';
    this.isMoving = false;
    this.dancing = false;
    this.danceMode = false; // toggled by the dance key; any movement clears it
    this._prevX = x;
    this._prevY = y;
    this._lastSentX = x;
    this._lastSentY = y;
    this._moved = false;

    // Custom avatars are animated spritesheets; color avatars are static frames
    this._custom = isCustomAvatar(avatarIndex) && !!customAt(avatarIndex);
    this.sprite = scene.physics.add.sprite(x, y, ...idleTextureArgs(avatarIndex));
    this.sprite.setCollideWorldBounds(true);
    this.sprite.setDepth(4);

    this.nameTag = scene.add.text(x, y - 38, name, {
      fontSize: '11px', color: '#fde68a', fontFamily: 'monospace',
      backgroundColor: '#1a202caa', padding: { x: 4, y: 2 }
    }).setOrigin(0.5).setDepth(4.1);

    this._youTag = scene.add.text(x, y - 52, '(you)', {
      fontSize: '10px', color: '#60a5fa', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(4.1);
  }

  // Toggle dance mode (key press). Movement will clear it on the next update.
  toggleDance() { this.danceMode = !this.danceMode; }

  // Returns true if position changed since last call.
  // extVel = { vx, vy } from touch joystick — takes priority over keys.
  update(cursors, wasd, extVel = null) {
    let vx, vy;

    if (extVel) {
      vx = extVel.vx;
      vy = extVel.vy;
      if (Math.abs(vx) >= Math.abs(vy)) {
        if (vx !== 0) this.direction = vx > 0 ? 'right' : 'left';
      } else {
        this.direction = vy > 0 ? 'down' : 'up';
      }
    } else {
      const up = cursors.up.isDown || wasd.up.isDown;
      const down = cursors.down.isDown || wasd.down.isDown;
      const left = cursors.left.isDown || wasd.left.isDown;
      const right = cursors.right.isDown || wasd.right.isDown;

      vx = 0; vy = 0;
      if (up) { vy = -PLAYER_SPEED; this.direction = 'up'; }
      else if (down) { vy = PLAYER_SPEED; this.direction = 'down'; }
      if (left) { vx = -PLAYER_SPEED; this.direction = 'left'; }
      else if (right) { vx = PLAYER_SPEED; this.direction = 'right'; }

      // Normalize diagonal
      if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }
    }

    this.sprite.setVelocity(vx, vy);
    this.isMoving = vx !== 0 || vy !== 0;
    if (this.isMoving) this.danceMode = false; // any movement breaks the dance
    this.dancing = this.danceMode && !this.isMoving;

    this._applyPose();

    const { x, y } = this.sprite;
    this.nameTag.setPosition(x, y - 36);
    this._youTag.setPosition(x, y - 50);

    const moved = x !== this._prevX || y !== this._prevY;
    this._prevX = x;
    this._prevY = y;
    return moved;
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
    this._youTag.destroy();
  }
}
