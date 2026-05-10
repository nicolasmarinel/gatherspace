import Phaser from 'phaser';

export class RemotePlayer {
  constructor(scene, id, x, y, avatarIndex, name) {
    this.scene = scene;
    this.id = id;
    this.avatarIndex = avatarIndex ?? 0;
    this.name = name || 'Player';
    this.targetX = x;
    this.targetY = y;
    this.direction = 'down';

    this.sprite = scene.add.image(x, y, `avatar-${this.avatarIndex}-down`);
    this.sprite.setDepth(4);

    this.nameTag = scene.add.text(x, y - 36, this.name, {
      fontSize: '11px', color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#1a202caa', padding: { x: 4, y: 2 }
    }).setOrigin(0.5).setDepth(4.1);
  }

  moveTo(x, y, direction, _isMoving) {
    this.targetX = x;
    this.targetY = y;
    if (direction) {
      this.direction = direction;
      this.sprite.setTexture(`avatar-${this.avatarIndex}-${this.direction}`);
    }
  }

  update(_delta) {
    // Smooth interpolation — catches up to server position
    const lerp = 0.2;
    this.sprite.x = Phaser.Math.Linear(this.sprite.x, this.targetX, lerp);
    this.sprite.y = Phaser.Math.Linear(this.sprite.y, this.targetY, lerp);
    this.nameTag.setPosition(this.sprite.x, this.sprite.y - 36);
  }

  destroy() {
    this.sprite.destroy();
    this.nameTag.destroy();
  }
}
