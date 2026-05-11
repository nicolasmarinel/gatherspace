import Phaser from 'phaser';
import { MAP_WIDTH, MAP_HEIGHT, PROXIMITY_OPEN_DIST, PROXIMITY_CLOSE_DIST } from '../constants.js';
import { LocalPlayer } from '../objects/LocalPlayer.js';
import { RemotePlayer } from '../objects/RemotePlayer.js';
import { SocketManager } from '../managers/SocketManager.js';
import { WebRTCManager } from '../managers/WebRTCManager.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
    this.remotePlayers = new Map();
  }

  init(data) {
    this.playerName = data.name;
    this.avatarIndex = data.avatarIndex;
    this.roomId = data.roomId;
  }

  create() {
    this.physics.world.setBounds(32, 32, MAP_WIDTH - 64, MAP_HEIGHT - 64);

    this._buildWorld();
    this._createLocalPlayer();
    this._setupSocket();
    this._setupWebRTC();
    this._setupCamera();
    this._setupHUD();
    this._setupKeys();
  }

  // ── world ─────────────────────────────────────────────────────────────────

  _buildWorld() {
    // Floor tiles
    for (let y = 0; y < MAP_HEIGHT; y += 64) {
      for (let x = 0; x < MAP_WIDTH; x += 64) {
        this.add.image(x + 32, y + 32, 'floor').setDepth(0);
      }
    }

    // Wood-floor strip for the lounge/kitchen areas
    for (let y = 896; y < MAP_HEIGHT; y += 64) {
      for (let x = 64; x < 900; x += 64) {
        this.add.image(x + 32, y + 32, 'floor-wood').setDepth(0);
      }
    }

    // Visual border walls
    const wallColor = 0x374151;
    [
      [MAP_WIDTH / 2, 16, MAP_WIDTH, 32],
      [MAP_WIDTH / 2, MAP_HEIGHT - 16, MAP_WIDTH, 32],
      [16, MAP_HEIGHT / 2, 32, MAP_HEIGHT],
      [MAP_WIDTH - 16, MAP_HEIGHT / 2, 32, MAP_HEIGHT],
    ].forEach(([x, y, w, h]) =>
      this.add.rectangle(x, y, w, h, wallColor).setDepth(1)
    );

    this._buildOffice();
    this._buildLounge();
    this._buildMeetingRoom();
    this._buildKitchen();
  }

  _buildOffice() {
    const clusters = [
      [260, 180], [580, 180], [900, 180], [1220, 180], [1540, 180], [1860, 180],
      [260, 460], [580, 460], [900, 460], [1220, 460], [1540, 460], [1860, 460],
    ];
    clusters.forEach(([x, y]) => {
      this._desk(x, y);
      this._desk(x + 110, y);
      this._desk(x, y + 110);
      this._desk(x + 110, y + 110);
      this._plant(x - 30, y - 30);
    });
  }

  _buildLounge() {
    const lx = 420, ly = 1200;
    this.add.image(lx, ly, 'rug').setDepth(1);
    this.add.image(lx, ly - 80, 'sofa').setDepth(2);
    this.add.image(lx, ly + 80, 'sofa').setDepth(2).setFlipY(true);
    this.add.image(lx, ly, 'table').setDepth(2).setScale(0.55);
    [[-130, -80], [130, -80], [-130, 80], [130, 80]].forEach(([dx, dy]) =>
      this._plant(lx + dx, ly + dy)
    );
    this._areaLabel(lx, ly - 170, '☕  Lounge');
  }

  _buildMeetingRoom() {
    const mx = 1380, my = 1100;
    const g = this.add.graphics().setDepth(1);
    g.lineStyle(3, 0x4b5563, 0.9);
    g.strokeRect(mx - 220, my - 160, 440, 320);
    this.add.image(mx, my, 'table').setDepth(2).setScale(1.3);
    [[-120, 0], [120, 0], [-60, -70], [60, -70], [-60, 70], [60, 70],
     [-120, -40], [120, -40], [-120, 40], [120, 40]].forEach(([dx, dy]) =>
      this.add.image(mx + dx, my + dy, 'chair').setDepth(2).setScale(0.85)
    );
    this._plant(mx - 200, my - 140);
    this._plant(mx + 200, my - 140);
    this._areaLabel(mx, my - 185, '📋  Meeting Room');
  }

  _buildKitchen() {
    const kx = 2100, ky = 500;
    this.add.image(kx - 50, ky - 60, 'desk').setDepth(2).setAngle(90);
    this.add.image(kx + 60, ky - 60, 'desk').setDepth(2).setAngle(90);
    this.add.image(kx, ky + 120, 'table').setDepth(2).setScale(0.75);
    [[-70, 120], [70, 120], [0, 180]].forEach(([dx, dy]) =>
      this.add.image(kx + dx, ky + dy, 'chair').setDepth(2)
    );
    this._plant(kx + 160, ky - 90);
    this._plant(kx - 160, ky + 120);
    this._areaLabel(kx, ky - 130, '🍽️  Kitchen');
  }

  _desk(x, y) {
    this.add.image(x, y, 'desk').setDepth(2);
    this.add.image(x, y + 48, 'chair').setDepth(2).setScale(0.9);
  }

  _plant(x, y) {
    this.add.image(x, y, 'plant').setDepth(2);
  }

  _areaLabel(x, y, text) {
    this.add.text(x, y, text, {
      fontSize: '15px', color: '#94a3b8', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 8, y: 4 }
    }).setOrigin(0.5).setDepth(6);
  }

  // ── players ───────────────────────────────────────────────────────────────

  _createLocalPlayer() {
    this.localPlayer = new LocalPlayer(
      this, MAP_WIDTH / 2, MAP_HEIGHT / 2, this.avatarIndex, this.playerName
    );
  }

  addRemotePlayer(data) {
    if (this.remotePlayers.has(data.id)) return;
    const rp = new RemotePlayer(this, data.id, data.x, data.y, data.avatar ?? 0, data.name);
    this.remotePlayers.set(data.id, rp);
  }

  updateRemotePlayer(id, x, y, direction, isMoving) {
    this.remotePlayers.get(id)?.moveTo(x, y, direction, isMoving);
  }

  removeRemotePlayer(id) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    rp.destroy();
    this.remotePlayers.delete(id);
    this.webRTC?.closePeer(id);
  }

  // ── socket / webrtc ───────────────────────────────────────────────────────

  _setupSocket() {
    this.socket = new SocketManager(this);
    this.socket.connect(
      this.roomId, this.playerName, this.avatarIndex,
      this.localPlayer.sprite.x, this.localPlayer.sprite.y
    );
  }

  _setupWebRTC() {
    this.webRTC = new WebRTCManager(this.socket, this.playerName);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _setupCamera() {
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.cameras.main.startFollow(this.localPlayer.sprite, true, 0.08, 0.08);
    this.cameras.main.setZoom(1.25);
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  _setupHUD() {
    const style = (s) => ({
      fontSize: s, color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 6, y: 3 }
    });

    this.add.text(14, 14, this.playerName, style('14px'))
      .setScrollFactor(0).setDepth(10);

    this.add.text(14, this.scale.height - 26, 'Move: WASD / Arrow Keys', {
      fontSize: '12px', color: '#4b5563', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(10);

    this.nearbyText = this.add.text(this.scale.width / 2, 14, '', {
      fontSize: '13px', color: '#86efac', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 8, y: 4 }
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(10);
  }

  _setupKeys() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
  }

  // ── update loop ───────────────────────────────────────────────────────────

  update(_time, delta) {
    if (!this.localPlayer) return;

    const moved = this.localPlayer.update(this.cursors, this.wasd);
    if (moved) {
      this.socket?.sendMove(
        this.localPlayer.sprite.x, this.localPlayer.sprite.y,
        this.localPlayer.direction, this.localPlayer.isMoving
      );
    }

    this.remotePlayers.forEach(rp => rp.update(delta));

    this._checkProximity();

    // Y-sort depth so players behind furniture appear behind it
    const localDepth = 3 + this.localPlayer.sprite.y / 10000;
    this.localPlayer.sprite.setDepth(localDepth);
    this.localPlayer.nameTag.setDepth(localDepth + 0.1);

    this.remotePlayers.forEach(rp => {
      const d = 3 + rp.sprite.y / 10000;
      rp.sprite.setDepth(d);
      rp.nameTag.setDepth(d + 0.1);
    });
  }

  _checkProximity() {
    const lx = this.localPlayer.sprite.x;
    const ly = this.localPlayer.sprite.y;
    const nearby = [];

    this.remotePlayers.forEach((rp, id) => {
      const dist = Phaser.Math.Distance.Between(lx, ly, rp.sprite.x, rp.sprite.y);

      if (dist < PROXIMITY_OPEN_DIST) {
        nearby.push(rp.name);
        this.webRTC?.onNearby(id, rp.name);
        this.webRTC?.setVolume(id, 1 - dist / PROXIMITY_OPEN_DIST);
      } else if (dist > PROXIMITY_CLOSE_DIST) {
        this.webRTC?.closePeer(id);
      }
    });

    this.nearbyText?.setText(
      nearby.length ? `📡 Near: ${nearby.join(', ')}` : ''
    );
  }

  shutdown() {
    this.socket?.disconnect();
    this.webRTC?.destroy();
  }
}
