import Phaser from 'phaser';
import { MAP_WIDTH, MAP_HEIGHT, PROXIMITY_OPEN_DIST, PROXIMITY_CLOSE_DIST, PLAYER_SPEED } from '../constants.js';
import { LocalPlayer } from '../objects/LocalPlayer.js';
import { RemotePlayer } from '../objects/RemotePlayer.js';
import { SocketManager } from '../managers/SocketManager.js';
import { WebRTCManager } from '../managers/WebRTCManager.js';
import { MapEditor } from '../MapEditor.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
    this.remotePlayers = new Map();
  }

  init(data) {
    this.playerName = data.name;
    this.avatarIndex = data.avatarIndex;
    this.roomId = data.roomId;
    this.identity = data.identity || null; // stable per-account id (Google sub)
    this.idToken = data.idToken || null;   // verified server-side on join
    this.email = data.email || null;
    this.picture = data.picture || null;
  }

  create() {
    this._isMobile = navigator.maxTouchPoints > 0;

    // A custom background image (if present) defines the map size so it isn't
    // stretched; otherwise fall back to the default procedural map dimensions.
    this._hasBg = this.textures.exists('bg-map');
    if (this._hasBg) {
      const img = this.textures.get('bg-map').getSourceImage();
      this.mapW = img.width;
      this.mapH = img.height;
    } else {
      this.mapW = MAP_WIDTH;
      this.mapH = MAP_HEIGHT;
    }

    this.physics.world.setBounds(32, 32, this.mapW - 64, this.mapH - 64);

    this._buildWorld();
    this._createLocalPlayer();
    this._setupSocket();
    this._setupWebRTC();
    this._setupCamera();
    this._setupHUD();
    this._setupKeys();
    this._setupJoystick();
    this._setupZoom();
    if (this._hasBg) this.mapEditor = new MapEditor(this);
  }

  // ── world ─────────────────────────────────────────────────────────────────

  _buildWorld() {
    // Custom map image replaces the entire procedural scene. Objects and
    // collisions are populated from the server's shared map (onMapState).
    if (this._hasBg) {
      this.add.image(this.mapW / 2, this.mapH / 2, 'bg-map').setDepth(0);
      this.mapObjects = new Map();          // id -> Phaser.Image
      this.collisionState = null;           // Uint8Array of 0/1
      this.collisionZones = new Map();      // tile index -> Zone
      this._collisionGroup = this.physics.add.staticGroup();
      return;
    }

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

  // ── shared map (server-driven) ──────────────────────────────────────────────

  // Full snapshot from the server (on join, or after a reconnect)
  onMapState(m) {
    if (!this._hasBg) return;
    this._mapTile = m.tile;
    [this._mapTilesW, this._mapTilesH] = m.dims;

    // Clear any prior render
    this.mapObjects.forEach(s => s.destroy());
    this.mapObjects.clear();
    this.collisionZones.forEach(z => z.destroy());
    this.collisionZones.clear();

    m.placements.forEach(o => this._addMapObjectSprite(o));

    this.collisionState = Uint8Array.from(atob(m.collisions), c => c.charCodeAt(0));
    for (let i = 0; i < this.collisionState.length; i++) {
      if (this.collisionState[i]) this._addCollisionZone(i);
    }

    this.zones = m.zones || [];
    this._rebuildZoneIndex();

    this.mapEditor?.onMapReloaded();
  }

  // ── private zones ───────────────────────────────────────────────────────────

  _rebuildZoneIndex() {
    this._cellZone = new Map();   // tile index -> zone id
    this._zoneById = new Map();   // zone id -> zone
    (this.zones || []).forEach(z => {
      this._zoneById.set(z.id, z);
      z.cells.forEach(c => this._cellZone.set(c, z.id));
    });
  }

  // Zone id at a world position, or null if on the open grounds
  _zoneAt(x, y) {
    if (!this._cellZone || !this._mapTile) return null;
    const T = this._mapTile, W = this._mapTilesW;
    const col = Math.floor(x / T), row = Math.floor(y / T);
    if (col < 0 || row < 0 || col >= W || row >= this._mapTilesH) return null;
    return this._cellZone.get(row * W + col) ?? null;
  }

  onMapZoneAdded(z) {
    if (!this._hasBg) return;
    this.zones = (this.zones || []).filter(x => x.id !== z.id).concat(z);
    this._rebuildZoneIndex();
    this.mapEditor?.onZonesReloaded();
    this._currentZoneId = undefined; // force indicator refresh next frame
  }

  onMapZoneRemoved(id) {
    this.zones = (this.zones || []).filter(z => z.id !== id);
    this._rebuildZoneIndex();
    this.mapEditor?.onZonesReloaded();
    this._currentZoneId = undefined;
  }

  // Darken the world + label the chat with the zone name when the local player
  // is inside a private zone.
  _updateLocalZone(localZone) {
    if (localZone === this._currentZoneId) return;
    this._currentZoneId = localZone;
    const zone = localZone != null ? this._zoneById?.get(localZone) : null;
    this._drawZoneDim(zone);
    this.webRTC?.setZoneLabel(zone ? zone.name : null);
  }

  // Darken the whole map except the given zone's tiles (the zone stays lit).
  // Uses per-row spans so it's a handful of rects, redrawn only on zone change.
  _drawZoneDim(zone) {
    const g = this._darkGfx;
    if (!g) return;
    g.clear();
    if (!zone) return;
    const T = this._mapTile, W = this._mapTilesW, H = this._mapTilesH;
    const inZone = new Set(zone.cells);
    g.fillStyle(0x00010a, 0.5);
    for (let row = 0; row < H; row++) {
      let start = -1;
      for (let col = 0; col <= W; col++) {
        const dark = col < W && !inZone.has(row * W + col);
        if (dark) {
          if (start === -1) start = col;
        } else if (start !== -1) {
          g.fillRect(start * T, row * T, (col - start) * T, T);
          start = -1;
        }
      }
    }
  }

  // Objects layer by their z value. Normal objects sit in the band (1,2) —
  // above the background (0), below players (3+). Objects flagged `above` sit
  // in (5,6) — above players (so avatars pass behind them), below the HUD (10).
  // atan keeps it monotonic in z and bounded for any z value.
  _objDepth(z, above) {
    const base = above ? 5.5 : 1.5;
    return base + Math.atan((z || 0) / 500) / Math.PI;
  }

  _addMapObjectSprite(o) {
    const key = `obj:${o.f}`;
    if (!this.textures.exists(key)) return null;
    const T = this._mapTile;
    const px = o.x * T + (o.ox || 0);
    const py = o.y * T + (o.oy || 0);
    const img = this.add.image(px, py, key).setOrigin(0, 0);
    img.setData('mapId', o.id);
    img.setData('obj', o);
    img.setDepth(this._objDepth(o.z, o.above));
    this.mapObjects.set(o.id, img);
    return img;
  }

  onMapObjectZ(id, z) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const o = img.getData('obj');
    o.z = z;
    img.setDepth(this._objDepth(z, o.above));
  }

  onMapObjectAbove(id, above) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const o = img.getData('obj');
    o.above = above;
    img.setDepth(this._objDepth(o.z, above));
    if (this.mapEditor?.selectedId === id) this.mapEditor._syncTools();
  }

  onMapObjectAdded(o) {
    if (!this._hasBg) return;
    if (!this.mapObjects.has(o.id)) this._addMapObjectSprite(o);
  }

  onMapObjectMoved({ id, x, y, ox, oy }) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const T = this._mapTile;
    img.setPosition(x * T + (ox || 0), y * T + (oy || 0));
    // depth stays driven by z (layer), independent of position
    const o = img.getData('obj');
    Object.assign(o, { x, y, ox: ox || 0, oy: oy || 0 });
  }

  onMapObjectRemoved(id) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    if (this.mapEditor?.selectedId === id) this.mapEditor.deselect();
    img.destroy();
    this.mapObjects.delete(id);
  }

  onMapCollision(cells) {
    if (!this.collisionState) return;
    cells.forEach(({ i, solid }) => {
      this.collisionState[i] = solid ? 1 : 0;
      if (solid) this._addCollisionZone(i); else this._removeCollisionZone(i);
    });
    this.mapEditor?.redrawOverlay();
  }

  _addCollisionZone(index) {
    if (this.collisionZones.has(index)) return;
    const T = this._mapTile, W = this._mapTilesW;
    const col = index % W, row = Math.floor(index / W);
    const zone = this.add.zone(col * T + T / 2, row * T + T / 2, T, T);
    this.physics.add.existing(zone, true);
    this._collisionGroup.add(zone);
    this.collisionZones.set(index, zone);
  }

  _removeCollisionZone(index) {
    const zone = this.collisionZones.get(index);
    if (!zone) return;
    this._collisionGroup.remove(zone);
    zone.destroy();
    this.collisionZones.delete(index);
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
      this, this.mapW / 2, this.mapH / 2, this.avatarIndex, this.playerName
    );
    // Solid tiles from the imported map block the local avatar
    if (this._collisionGroup) {
      this.physics.add.collider(this.localPlayer.sprite, this._collisionGroup);
    }
  }

  addRemotePlayer(data) {
    if (this.remotePlayers.has(data.id)) return;
    // Dedup by account: if another socket with the same identity is still
    // around (a ghost), drop it so we never show the same person twice.
    if (data.sessionId) {
      this.remotePlayers.forEach((rp, id) => {
        if (id !== data.id && rp.sessionId === data.sessionId) this.removeRemotePlayer(id);
      });
    }
    const rp = new RemotePlayer(this, data.id, data.x, data.y, data.avatar ?? 0, data.name);
    rp.sessionId = data.sessionId;
    rp.zoneId = data.zone ?? null;
    this.remotePlayers.set(data.id, rp);
  }

  updateRemotePlayer(id, x, y, direction, isMoving, dancing, zone) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    rp.moveTo(x, y, direction, isMoving, dancing);
    rp.zoneId = zone ?? null;
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
      this.localPlayer.sprite.x, this.localPlayer.sprite.y, this.identity, this.idToken
    );
  }

  _setupWebRTC() {
    this.webRTC = new WebRTCManager(this.socket, this.playerName, {
      email: this.email, picture: this.picture,
    });
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _setupCamera() {
    this.cameras.main.setBounds(0, 0, this.mapW, this.mapH);
    this.cameras.main.startFollow(this.localPlayer.sprite, true, 0.08, 0.08);
    this._zoom = 1.25;
    this._zoomMin = 0.6;
    this._zoomMax = 2.5;
    this.cameras.main.setZoom(this._zoom);
  }

  // ── zoom ────────────────────────────────────────────────────────────────────

  _setupZoom() {
    // Mouse wheel
    this.input.on('wheel', (_p, _over, _dx, dy) => {
      this._applyZoom(this._zoom - Math.sign(dy) * 0.15);
    });
    // Keyboard +/- (and = for the unshifted plus key)
    this.input.keyboard.on('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this._applyZoom(this._zoom + 0.15);
      else if (e.key === '-' || e.key === '_') this._applyZoom(this._zoom - 0.15);
    });

    // On-screen zoom widget (also for touch) — bottom-left, above the HUD text
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position:fixed; bottom:54px; left:14px; z-index:100; display:flex; gap:6px;
    `;
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `
        width:34px; height:34px; border-radius:8px; cursor:pointer;
        background:#1e293b; border:1px solid #334155; color:#e2e8f0;
        font-family:monospace; font-size:18px; line-height:1;
      `;
      b.addEventListener('click', () => { fn(); b.blur(); });
      return b;
    };
    wrap.append(
      mkBtn('−', () => this._applyZoom(this._zoom - 0.25)),
      mkBtn('+', () => this._applyZoom(this._zoom + 0.25)),
    );
    document.body.appendChild(wrap);
    this._zoomWidget = wrap;
  }

  _applyZoom(z) {
    this._zoom = Phaser.Math.Clamp(z, this._zoomMin, this._zoomMax);
    this.cameras.main.setZoom(this._zoom);
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  _setupHUD() {
    // World-space dimmer: when inside a private zone, everything EXCEPT the
    // zone's own tiles is darkened (depth 9 — above world/avatars, below HUD).
    this._darkGfx = this.add.graphics().setDepth(9);

    const style = (s) => ({
      fontSize: s, color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 6, y: 3 }
    });

    // Name + move hint live bottom-left; the top-left is now the video filmstrip
    this.add.text(14, this.scale.height - 48, this.playerName, style('14px'))
      .setScrollFactor(0).setDepth(10);

    const hint = this._isMobile ? 'Touch & drag to move' : 'Move: WASD / Arrows  ·  Zoom: + / −  ·  Dance: Z';
    this.add.text(14, this.scale.height - 26, hint, {
      fontSize: '12px', color: '#4b5563', fontFamily: 'monospace'
    }).setScrollFactor(0).setDepth(10);

    this.nearbyText = this.add.text(this.scale.width / 2, 14, '', {
      fontSize: '13px', color: '#86efac', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 8, y: 4 }
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(10);
  }

  _setupKeys() {
    this.cursors = this.input.keyboard.createCursorKeys();
    // WASD movement. Safe alongside chat: movement is frozen while a text input
    // is focused, and chat keystrokes stopPropagation so they never reach here.
    this.wasd = {
      up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    // Press Z to toggle dance mode (stays dancing until you move)
    this.input.keyboard.on('keydown-Z', () => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't trigger while typing
      this.localPlayer?.toggleDance();
    });

    // Clicking the game world drops focus from any text input (e.g. chat),
    // so movement resumes without needing to hunt for an escape.
    this.input.on('pointerdown', () => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
    });
  }

  _setupJoystick() {
    if (!this._isMobile) return;

    this._joystick = { active: false, pointerId: -1, startX: 0, startY: 0, dx: 0, dy: 0 };
    this._joystickGfx = this.add.graphics().setScrollFactor(0).setDepth(50);

    this.input.on('pointerdown', (ptr) => {
      if (this.mapEditor?.active) return; // editor owns pointer input
      if (!ptr.wasTouch || this._joystick.active) return;
      this._joystick.active = true;
      this._joystick.pointerId = ptr.id;
      this._joystick.startX = ptr.x;
      this._joystick.startY = ptr.y;
      this._joystick.dx = 0;
      this._joystick.dy = 0;
    });

    this.input.on('pointermove', (ptr) => {
      if (!this._joystick.active || ptr.id !== this._joystick.pointerId) return;
      const MAX = 60;
      const rawDx = ptr.x - this._joystick.startX;
      const rawDy = ptr.y - this._joystick.startY;
      const len = Math.sqrt(rawDx * rawDx + rawDy * rawDy) || 1;
      const scale = Math.min(len, MAX) / len;
      this._joystick.dx = rawDx * scale;
      this._joystick.dy = rawDy * scale;
    });

    this.input.on('pointerup', (ptr) => {
      if (ptr.id !== this._joystick.pointerId) return;
      this._joystick.active = false;
      this._joystick.dx = 0;
      this._joystick.dy = 0;
      this._joystickGfx.clear();
    });
  }

  _getJoystickVelocity() {
    if (!this._joystick?.active) return null;
    const { dx, dy } = this._joystick;
    if (dx === 0 && dy === 0) return null;
    const MAX = 60;
    return { vx: (dx / MAX) * PLAYER_SPEED, vy: (dy / MAX) * PLAYER_SPEED };
  }

  _drawJoystick() {
    if (!this._joystick?.active) return;
    const g = this._joystickGfx;
    const { startX, startY, dx, dy } = this._joystick;
    const MAX = 60;
    g.clear();
    g.lineStyle(3, 0xffffff, 0.25);
    g.strokeCircle(startX, startY, MAX);
    g.fillStyle(0xffffff, 0.08);
    g.fillCircle(startX, startY, MAX);
    g.fillStyle(0xffffff, 0.45);
    g.fillCircle(startX + dx, startY + dy, 26);
  }

  // ── update loop ───────────────────────────────────────────────────────────

  update(_time, delta) {
    if (!this.localPlayer) return;

    // Map-editor mode: avatar is parked; pan the camera with the keys instead
    if (this.mapEditor?.active) {
      this.localPlayer.sprite.setVelocity(0, 0);
      this.mapEditor.updatePan(delta);
      this.remotePlayers.forEach(rp => rp.update(delta));
      return;
    }

    // Freeze movement when the user is typing in a chat or settings input
    const tag = document.activeElement?.tagName;
    const inputFocused = tag === 'INPUT' || tag === 'TEXTAREA';

    let moved = false;
    if (inputFocused) {
      this.localPlayer.sprite.setVelocity(0, 0);
    } else {
      moved = this.localPlayer.update(this.cursors, this.wasd, this._getJoystickVelocity());
    }
    if (this._joystick) this._drawJoystick();

    // Broadcast on movement OR any state change (direction / walking / dancing /
    // zone), so idle dances and zone crossings propagate even without movement.
    const lp = this.localPlayer;
    const localZone = this._zoneAt(lp.sprite.x, lp.sprite.y);
    const sig = `${lp.direction}|${lp.isMoving}|${lp.dancing}|${localZone}`;
    if (moved || sig !== this._lastSendSig) {
      this.socket?.sendMove(lp.sprite.x, lp.sprite.y, lp.direction, lp.isMoving, lp.dancing, localZone);
      this._lastSendSig = sig;
    }

    this.remotePlayers.forEach(rp => rp.update(delta));

    this._checkProximity(localZone);

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

  _checkProximity(localZone = this._zoneAt(this.localPlayer.sprite.x, this.localPlayer.sprite.y)) {
    const lx = this.localPlayer.sprite.x;
    const ly = this.localPlayer.sprite.y;
    const nearby = [];

    this.remotePlayers.forEach((rp, id) => {
      // Authoritative zone the peer reported (not guessed from a lerped sprite)
      const remoteZone = rp.zoneId ?? null;

      if (localZone !== null || remoteZone !== null) {
        // Private-zone rules: a call connects only when BOTH are in the same
        // zone (any distance). One in / one out (or different zones) = no call.
        if (localZone !== null && localZone === remoteZone) {
          nearby.push(rp.name);
          this.webRTC?.onNearby(id, rp.name);
          this.webRTC?.setVolume(id, 1); // full volume inside a shared room
        } else {
          this.webRTC?.closePeer(id);
        }
      } else {
        // Open grounds: distance-based proximity with hysteresis
        const dist = Phaser.Math.Distance.Between(lx, ly, rp.sprite.x, rp.sprite.y);
        if (dist < PROXIMITY_OPEN_DIST) {
          nearby.push(rp.name);
          this.webRTC?.onNearby(id, rp.name);
          this.webRTC?.setVolume(id, 1 - dist / PROXIMITY_OPEN_DIST);
        } else if (dist > PROXIMITY_CLOSE_DIST) {
          this.webRTC?.closePeer(id);
        }
      }
    });

    this.nearbyText?.setText(
      nearby.length ? `📡 Near: ${nearby.join(', ')}` : ''
    );
    this._updateLocalZone(localZone);
  }

  // Server refused the connection (allowlist / invalid token / auth required)
  onAuthError(reason) {
    const msg = reason === 'not-allowed'
      ? 'This Google account isn’t on the guest list for this space.'
      : 'Sign-in required — please reload and sign in again.';
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed; inset:0; z-index:9999; display:flex; align-items:center;
      justify-content:center; background:#0b1220; color:#e2e8f0;
      font-family:monospace; font-size:16px; text-align:center; padding:24px;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
  }

  // Called by SocketManager when the socket reconnects with a new ID.
  // Clears stale remote-player state; room-state from the server re-populates it.
  onSocketReconnect() {
    this.remotePlayers.forEach(rp => rp.destroy());
    this.remotePlayers.clear();
    this.webRTC?.onSocketReconnect();
  }

  shutdown() {
    this.socket?.disconnect();
    this.webRTC?.destroy();
    this._zoomWidget?.remove();
    this.mapEditor?.destroy();
  }
}
