import { PLAYER_SPEED } from '../constants.js';

export class LocalPlayer {
  constructor(scene, x, y, avatarIndex, name) {
    this.scene = scene;
    this.avatarIndex = avatarIndex;
    this.name = name;
    this.direction = 'down';
    this.isMoving = false;
    this._prevX = x;
    this._prevY = y;
    this._lastSentX = x;
    this._lastSentY = y;
    this._moved = false;

    this.sprite = scene.physics.add.sprite(x, y, `avatar-${avatarIndex}-down`);
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

  // Returns true if position changed since last call
  update(cursors, wasd) {
    const up = cursors.up.isDown || wasd.up.isDown;
    const down = cursors.down.isDown || wasd.down.isDown;
    const left = cursors.left.isDown || wasd.left.isDown;
    const right = cursors.right.isDown || wasd.right.isDown;

    let vx = 0, vy = 0;
    if (up) { vy = -PLAYER_SPEED; this.direction = 'up'; }
    else if (down) { vy = PLAYER_SPEED; this.direction = 'down'; }
    if (left) { vx = -PLAYER_SPEED; this.direction = 'left'; }
    else if (right) { vx = PLAYER_SPEED; this.direction = 'right'; }

    // Normalize diagonal
    if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }

    this.sprite.setVelocity(vx, vy);
    const nowMoving = vx !== 0 || vy !== 0;

    if (nowMoving !== this.isMoving || (nowMoving && this.direction !== this._lastDir)) {
      this.sprite.setTexture(`avatar-${this.avatarIndex}-${this.direction}`);
      this._lastDir = this.direction;
    }
    this.isMoving = nowMoving;

    const { x, y } = this.sprite;
    this.nameTag.setPosition(x, y - 36);
    this._youTag.setPosition(x, y - 50);

    const moved = x !== this._prevX || y !== this._prevY;
    this._prevX = x;
    this._prevY = y;
    return moved;
  }

  destroy() {
    this.sprite.destroy();
    this.nameTag.destroy();
    this._youTag.destroy();
  }
}
