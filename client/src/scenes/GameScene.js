import Phaser from 'phaser';
import { MAP_WIDTH, MAP_HEIGHT, PROXIMITY_OPEN_DIST, PROXIMITY_CLOSE_DIST, PLAYER_SPEED, ADMIN_EMAILS } from '../constants.js';
import { LocalPlayer } from '../objects/LocalPlayer.js';
import { RemotePlayer } from '../objects/RemotePlayer.js';
import { SocketManager } from '../managers/SocketManager.js';
import { WebRTCManager } from '../managers/WebRTCManager.js';
import { MapEditor } from '../MapEditor.js';
import { PostitManager } from '../Postits.js';
// import { PiPManager } from '../PiPManager.js'; // PiP disabled in deployment (kept for future use)

// Avatars sit at layer 0 (depth ~LAYER_BASE). Objects render at
// LAYER_BASE + layer + foot-based y-sort, so an object's `layer` places it any
// number of steps above (>0) or below (<0) avatars; layer 0 y-sorts with them.
const LAYER_BASE = 4;
const FOOT_DIV = 100000;   // within-layer y-sort granularity
const NAME_DEPTH = 8.6;    // name tags above all object layers, below the dimmer (9)

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
    this.postits = new PostitManager(this);
    this._setupSocket();
    this._setupWebRTC();
    this._setupCamera();
    this._setupHUD();
    this._setupKeys();
    this._setupJoystick();
    this._setupZoom();
    this._setupCameraDrag();
    if (this._hasBg) {
      this.mapEditor = new MapEditor(this);
      // The bottom bar's hammer drives the editor
      if (this.webRTC) {
        this.webRTC.onEditMap = () => {
          this.mapEditor.active ? this.mapEditor.exit() : this.mapEditor.enter();
        };
      }
    }
    // Picture-in-Picture is disabled in deployment (kept for possible future use).
    // To re-enable: uncomment the wiring below, the PiP button in WebRTCManager's
    // bar, and the "Enable PiP" Settings section.
    // this.pip = new PiPManager(this);
    // if (this.webRTC) {
    //   this.webRTC.onTogglePiP = () => this.pip?.toggle();
    //   this.webRTC.onSetPiPAuto = (on) => this.pip?.setAutoEnable(on);
    //   if (this.pip?._unsupported) this.webRTC.hidePiPButton?.();
    // }
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
      this._lockCollisionGroup = this.physics.add.staticGroup(); // locked private zones
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
    this._rebuildLockCollisions();

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
    const ref = z._ref; if (ref !== undefined) delete z._ref;
    this.zones = (this.zones || []).filter(x => x.id !== z.id).concat(z);
    this._rebuildZoneIndex();
    this.mapEditor?.onZonesReloaded();
    this._currentZoneId = undefined; // force indicator refresh next frame
    if (ref) this.mapEditor?._resolveRef(ref, z.id);
  }

  onMapZoneRemoved(id) {
    this.zones = (this.zones || []).filter(z => z.id !== id);
    this._rebuildZoneIndex();
    this.mapEditor?.onZonesReloaded();
    this._currentZoneId = undefined;
  }

  onMapZoneClaimed(id, owner) {
    const z = this._zoneById?.get(id);
    if (z) z.owner = owner || null;
    this.mapEditor?.onZonesReloaded();
    this._currentZoneId = undefined; // refresh the lock button's permission state
  }

  _myEmail() { return (this.email || '').toLowerCase(); }
  _isAdmin() { return ADMIN_EMAILS.includes(this._myEmail()); }

  // Can the local user edit an object at this tile? (free tile / zone owner / admin)
  canEditTile(tx, ty) {
    const W = this._mapTilesW;
    if (!W) return true;
    const idx = ty * W + tx;
    const email = this._myEmail();
    for (const z of (this.zones || [])) {
      if (z.owner && z.cells.includes(idx)) return z.owner === email || this._isAdmin();
    }
    return true;
  }

  // Can the local user lock/unlock a zone? (unclaimed, its owner, or admin)
  _canControlZone(zone) {
    return !zone.owner || zone.owner === this._myEmail() || this._isAdmin();
  }

  // Darken the world + label the chat with the zone name when the local player
  // is inside a private zone.
  _updateLocalZone(localZone) {
    if (localZone === this._currentZoneId) return;
    this._currentZoneId = localZone;
    const zone = localZone != null ? this._zoneById?.get(localZone) : null;
    this._drawZoneDim(zone);
    this.webRTC?.setZoneLabel(
      zone ? zone.name : null,
      zone ? !!zone.locked : false,
      zone ? this._canControlZone(zone) : false,
    );
    this._rebuildLockCollisions(localZone); // entering/leaving a locked zone changes passability
  }

  onMapZoneLocked(id, locked) {
    const z = this._zoneById?.get(id);
    if (z) z.locked = locked;
    this._rebuildLockCollisions();
    if (this._currentZoneId === id) this.webRTC?.setZoneLabel(z?.name, locked);
    this.mapEditor?.onZonesReloaded();
  }

  // A locked zone is solid for everyone NOT currently inside it.
  _rebuildLockCollisions(localZone = this._zoneAt(this.localPlayer?.sprite.x ?? 0, this.localPlayer?.sprite.y ?? 0)) {
    if (!this._lockCollisionGroup) return;
    this._lockCollisionGroup.clear(true, true);
    const T = this._mapTile, W = this._mapTilesW;
    if (!T) return;
    (this.zones || []).forEach(z => {
      if (!z.locked || z.id === localZone) return; // unlocked, or I'm inside → passable
      z.cells.forEach(i => {
        const col = i % W, row = Math.floor(i / W);
        const zone = this.add.zone(col * T + T / 2, row * T + T / 2, T, T);
        this.physics.add.existing(zone, true);
        this._lockCollisionGroup.add(zone);
      });
    });
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

  // Depth from the object's avatar-relative layer + its foot (for y-sort within
  // a layer) + z (a fine tiebreak for objects sharing a foot).
  _objDepthFor(img, o) {
    const foot = img.y + img.height; // origin is top-left
    return LAYER_BASE + (o.layer || 0) + foot / FOOT_DIV + (o.z || 0) / 1e9;
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
    img.setDepth(this._objDepthFor(img, o));
    this.mapObjects.set(o.id, img);
    return img;
  }

  onMapObjectZ(id, z) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const o = img.getData('obj');
    o.z = z;
    img.setDepth(this._objDepthFor(img, o));
  }

  onMapObjectLayer(id, layer) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const o = img.getData('obj');
    o.layer = layer;
    img.setDepth(this._objDepthFor(img, o));
    if (this.mapEditor?.selectedId === id) this.mapEditor._syncTools();
  }

  onMapObjectAdded(o) {
    if (!this._hasBg) return;
    const ref = o._ref; if (ref !== undefined) delete o._ref;
    if (!this.mapObjects.has(o.id)) this._addMapObjectSprite(o);
    if (ref) this.mapEditor?._resolveRef(ref, o.id);
  }

  onMapObjectMoved({ id, x, y, ox, oy }) {
    const img = this.mapObjects?.get(id);
    if (!img) return;
    const T = this._mapTile;
    img.setPosition(x * T + (ox || 0), y * T + (oy || 0));
    const o = img.getData('obj');
    Object.assign(o, { x, y, ox: ox || 0, oy: oy || 0 });
    img.setDepth(this._objDepthFor(img, o)); // foot changed → re-sort
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
    // Solid tiles from the imported map (and locked private zones) block the avatar
    if (this._collisionGroup) {
      this.physics.add.collider(this.localPlayer.sprite, this._collisionGroup);
    }
    if (this._lockCollisionGroup) {
      this.physics.add.collider(this.localPlayer.sprite, this._lockCollisionGroup);
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
    rp.email = (data.email || '').toLowerCase() || null;
    rp.zoneId = data.zone ?? null;
    if (data.status) rp.setStatus(data.status);
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
    // Lock/unlock the private zone the local player is currently inside
    this.webRTC.onToggleZoneLock = () => {
      const z = this._currentZoneId != null ? this._zoneById?.get(this._currentZoneId) : null;
      if (z) this.socket?.sendZoneLock(z.id, !z.locked);
    };
    // Availability status (Available / DND)
    this._status = 'available';
    this.webRTC.onSetStatus = (status) => this.setStatus(status);
  }

  setStatus(status) {
    this._status = status === 'dnd' ? 'dnd' : 'available';
    this.localPlayer?.setStatus(this._status);
    this.socket?.sendStatus(this._status);
    // DND immediately tears down any active calls (proximity loop also enforces it)
    if (this._status === 'dnd') this.remotePlayers.forEach((_, id) => this.webRTC?.closePeer(id));
  }

  updateRemoteStatus(id, status) {
    this.remotePlayers.get(id)?.setStatus(status);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _setupCamera() {
    this.cameras.main.setBounds(0, 0, this.mapW, this.mapH);
    this.cameras.main.startFollow(this.localPlayer.sprite, true, 0.08, 0.08);
    this._following = true; // false while the user is free-panning the camera
    this._zoom = 1.25;
    this._zoomMin = 0.6;
    this._zoomMax = 2.5;
    this.cameras.main.setZoom(this._zoom);
  }

  // Detach the camera from the avatar so the user can look around freely.
  _beginManualPan() {
    if (!this._following) return;
    this.cameras.main.stopFollow();
    this._following = false;
  }

  // Re-attach to the avatar (called when they start moving again).
  _resumeFollow() {
    if (this._following || !this.localPlayer) return;
    this.cameras.main.startFollow(this.localPlayer.sprite, true, 0.08, 0.08);
    this._following = true;
  }

  // Drag the camera by a screen-space delta (respects zoom; bounds clamp it).
  _panBy(dx, dy) {
    if (dx === 0 && dy === 0) return;
    this._beginManualPan();
    const cam = this.cameras.main;
    cam.scrollX -= dx / cam.zoom;
    cam.scrollY -= dy / cam.zoom;
  }

  // Desktop: left-click drag pans the camera (right-click is reserved for
  // waving); a left-click without a drag interacts with the world (desk / note).
  _setupCameraDrag() {
    this.input.on('pointerdown', (pointer) => {
      if (this.mapEditor?.active || pointer.wasTouch || pointer.rightButtonDown()) return;
      if (this.postits?.isPlacing()) return; // a click will place the note (handled on up)
      this._mouseDrag = { x: pointer.x, y: pointer.y, moved: false };
    });
    this.input.on('pointermove', (pointer) => {
      if (!this._mouseDrag || this.mapEditor?.active || pointer.wasTouch) return;
      if (!pointer.isDown) { this._mouseDrag = null; return; }
      const dx = pointer.x - this._mouseDrag.x;
      const dy = pointer.y - this._mouseDrag.y;
      this._mouseDrag.x = pointer.x; this._mouseDrag.y = pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) this._mouseDrag.moved = true;
      this._panBy(dx, dy);
    });
    this.input.on('pointerup', (pointer) => {
      if (pointer.wasTouch) return;
      if (this.postits?.isPlacing()) { this.postits.tryPlaceAt(pointer.worldX, pointer.worldY); return; }
      if (this._mouseDrag && !this._mouseDrag.moved) {
        this._handleWorldTap(pointer.x, pointer.y, pointer.worldX, pointer.worldY);
      }
      this._mouseDrag = null;
    });
  }

  // Touch pointers currently pressed (excludes the mouse)
  _downTouches() {
    return [this.input.pointer1, this.input.pointer2, this.input.pointer3]
      .filter(p => p && p.isDown && p.wasTouch);
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

    // On-screen zoom widget (also for touch) — bottom-left, above the control bar
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position:fixed; bottom:62px; left:14px; z-index:120; display:flex; gap:6px;
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

    // Name now lives in the bottom bar. Keep a small controls hint top-center.
    const hint = this._isMobile ? 'Touch & drag to move' : 'WASD / Arrows · Zoom + / − · Dance Z';
    this.add.text(this.scale.width / 2, this.scale.height - 78, hint, {
      fontSize: '12px', color: '#475569', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(10);

    this.nearbyText = this.add.text(this.scale.width / 2, 14, '', {
      fontSize: '13px', color: '#86efac', fontFamily: 'monospace',
      backgroundColor: '#1a202ccc', padding: { x: 8, y: 4 }
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(10);

    // Wave banner — shown just above the bottom toolbar when someone waves at us
    this._waveNotice = this.add.text(this.scale.width / 2, this.scale.height - 112, '', {
      fontSize: '15px', color: '#fde68a', fontFamily: 'monospace',
      backgroundColor: '#1a202cee', padding: { x: 12, y: 6 },
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(11).setVisible(false);
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

    // Right-click another avatar → "Wave to [name]" context menu
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (pointer) => {
      if (!pointer.rightButtonDown()) return;
      if (this.mapEditor?.active) return;
      const rp = this._remotePlayerAt(pointer.worldX, pointer.worldY);
      if (rp) this._showWaveMenu(pointer, rp);
      else this._hideContextMenu();
    });
  }

  // Topmost remote avatar whose sprite bounds contain the world point (if any)
  _remotePlayerAt(wx, wy) {
    let found = null;
    this.remotePlayers.forEach(rp => {
      if (Phaser.Geom.Rectangle.Contains(rp.sprite.getBounds(), wx, wy)) found = rp;
    });
    return found;
  }

  // Generic floating menu at a screen position. items: {label, disabled?, onClick}
  _showContextMenu(sx, sy, items) {
    this._hideContextMenu();
    const menu = document.createElement('div');
    menu.style.cssText = `position:fixed; z-index:250; left:${sx}px; top:${sy}px;
      background:#1e293b; border:1px solid #334155; border-radius:8px; padding:4px;
      font-family:monospace; box-shadow:0 6px 20px #000a; min-width:150px;`;
    items.forEach(it => {
      const btn = document.createElement('button');
      btn.textContent = it.label;
      const dis = !!it.disabled;
      btn.style.cssText = `display:block; width:100%; text-align:left; background:none; border:none;
        color:${dis ? '#64748b' : '#e2e8f0'}; cursor:${dis ? 'default' : 'pointer'};
        font-size:13px; padding:8px 12px; border-radius:6px; white-space:nowrap;`;
      if (!dis) {
        btn.addEventListener('mouseenter', () => btn.style.background = '#334155');
        btn.addEventListener('mouseleave', () => btn.style.background = 'none');
        btn.addEventListener('click', () => { this._hideContextMenu(); it.onClick(); });
      }
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    this._ctxMenu = menu;

    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth)  menu.style.left = `${window.innerWidth - r.width - 6}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 6}px`;

    this._ctxDismiss = (e) => { if (this._ctxMenu && !this._ctxMenu.contains(e.target)) this._hideContextMenu(); };
    setTimeout(() => window.addEventListener('pointerdown', this._ctxDismiss, true), 0);
  }

  _hideContextMenu() {
    if (this._ctxDismiss) {
      window.removeEventListener('pointerdown', this._ctxDismiss, true);
      this._ctxDismiss = null;
    }
    this._ctxMenu?.remove();
    this._ctxMenu = null;
  }

  _showWaveMenu(pointer, rp) {
    const dnd = rp.status === 'dnd';
    this._showContextMenu(pointer.x, pointer.y, [{
      label: dnd ? `⛔ ${rp.name} is in DND` : `👋 Wave to ${rp.name}`,
      disabled: dnd,
      onClick: () => this.socket?.sendWave(rp.id),
    }]);
  }

  _findRemoteByEmail(email) {
    let found = null;
    this.remotePlayers.forEach((rp, id) => { if (rp.email && rp.email === email) found = { id, rp }; });
    return found;
  }

  _ownerName(email) {
    const u = this.webRTC?._presence?.find(p => p.email === email);
    if (u) return u.name;
    return this._findRemoteByEmail(email)?.rp.name || email;
  }

  // A claimed zone owned by someone other than me at this world point
  _claimedDeskAt(wx, wy) {
    const zid = this._zoneAt(wx, wy);
    if (zid == null) return null;
    const z = this._zoneById?.get(zid);
    if (!z?.owner || z.owner === this._myEmail()) return null;
    return z;
  }

  // Desk menu: wave / chat / leave a post-it for the desk's owner
  _showDeskMenu(sx, sy, zone) {
    const owner = zone.owner;
    const name = this._ownerName(owner);
    const r = this._findRemoteByEmail(owner);
    const canWave = !!r && r.rp.status !== 'dnd';
    this._showContextMenu(sx, sy, [
      { label: canWave ? `👋 Wave to ${name}` : '👋 Wave (unavailable)', disabled: !canWave,
        onClick: () => this.socket?.sendWave(r.id) },
      { label: `💬 Chat with ${name}`, onClick: () => this.webRTC?.openDMExternal(owner) },
      { label: '📝 Leave a post-it', onClick: () => this.postits?.startAuthoring(owner, name) },
    ]);
  }

  // Routed from a click/tap on the world: placing > note > desk
  _handleWorldTap(sx, sy, wx, wy) {
    if (this.postits?.isPlacing()) { this.postits.tryPlaceAt(wx, wy); return true; }
    const note = this.postits?.noteAt(wx, wy);
    if (note) { this.postits.openNote(note.id); return true; }
    const desk = this._claimedDeskAt(wx, wy);
    if (desk) { this._showDeskMenu(sx, sy, desk); return true; }
    return false;
  }

  _setupJoystick() {
    if (!this._isMobile) return;

    this.input.addPointer(2); // need up to 3 pointers for two-finger panning
    this._joystick = { active: false, pointerId: -1, startX: 0, startY: 0, dx: 0, dy: 0 };
    this._joystickGfx = this.add.graphics().setScrollFactor(0).setDepth(50);
    this._twoFinger = null;
    this._tapCandidate = null;

    this.input.on('pointerdown', (ptr) => {
      if (this.mapEditor?.active || !ptr.wasTouch) return; // editor owns pointer input
      if (this.postits?.isPlacing()) return; // a tap will place the note (handled on up)

      // Two fingers down → free-pan the map; cancel any joystick / pending tap
      if (this._downTouches().length >= 2) {
        this._joystick.active = false;
        this._joystickGfx.clear();
        this._tapCandidate = null;
        this._worldTap = null;
        const [a, b] = this._downTouches();
        this._twoFinger = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return;
      }
      if (this._joystick.active) return;

      // Tapping on another avatar waves at them — don't start the joystick so the
      // avatar never drifts; a real drag cancels the tap (see pointermove).
      const rp = this._remotePlayerAt(ptr.worldX, ptr.worldY);
      if (rp) {
        this._tapCandidate = { id: ptr.id, rp, x: ptr.x, y: ptr.y, t: this.time.now };
        return;
      }

      // Otherwise track a possible tap on the world (desk / post-it), while still
      // letting a drag drive the joystick.
      this._worldTap = { id: ptr.id, x: ptr.x, y: ptr.y, t: this.time.now };
      this._joystick.active = true;
      this._joystick.pointerId = ptr.id;
      this._joystick.startX = ptr.x;
      this._joystick.startY = ptr.y;
      this._joystick.dx = 0;
      this._joystick.dy = 0;
    });

    this.input.on('pointermove', (ptr) => {
      // Two-finger pan: follow the midpoint of the two touches
      if (this._twoFinger) {
        const t = this._downTouches();
        if (t.length < 2) return;
        const [a, b] = t;
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this._panBy(cx - this._twoFinger.x, cy - this._twoFinger.y);
        this._twoFinger = { x: cx, y: cy };
        return;
      }
      // Moved too far for a tap → it's a drag, not a wave / world tap
      if (this._tapCandidate && ptr.id === this._tapCandidate.id
          && Math.hypot(ptr.x - this._tapCandidate.x, ptr.y - this._tapCandidate.y) > 12) {
        this._tapCandidate = null;
      }
      if (this._worldTap && ptr.id === this._worldTap.id
          && Math.hypot(ptr.x - this._worldTap.x, ptr.y - this._worldTap.y) > 12) {
        this._worldTap = null;
      }
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
      if (this._twoFinger && this._downTouches().length < 2) this._twoFinger = null;

      // Placing a post-it: a tap drops it
      if (ptr.wasTouch && this.postits?.isPlacing()) {
        this.postits.tryPlaceAt(ptr.worldX, ptr.worldY);
        return;
      }

      // Quick tap on an avatar (little movement, short hold) → open the wave menu
      const tc = this._tapCandidate;
      if (tc && ptr.id === tc.id) {
        this._tapCandidate = null;
        if (this.time.now - tc.t < 300 && Math.hypot(ptr.x - tc.x, ptr.y - tc.y) <= 12) {
          this._showWaveMenu(ptr, tc.rp);
        }
      }

      // Quick tap elsewhere → world interaction (post-it / desk menu)
      const wt = this._worldTap;
      if (wt && ptr.id === wt.id) {
        this._worldTap = null;
        if (this.time.now - wt.t < 300 && Math.hypot(ptr.x - wt.x, ptr.y - wt.y) <= 12) {
          this._handleWorldTap(ptr.x, ptr.y, ptr.worldX, ptr.worldY);
        }
      }

      if (ptr.id === this._joystick.pointerId) {
        this._joystick.active = false;
        this._joystick.dx = 0;
        this._joystick.dy = 0;
        this._joystickGfx.clear();
      }
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

    // Moving re-centers the camera on the avatar (undoes any free-pan)
    if (moved && !this._following) this._resumeFollow();

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

    // Y-sort avatars within the avatar layer (foot = sprite bottom). Objects on
    // layer 0 share this band and interleave naturally; other layers are above/below.
    const ls = this.localPlayer.sprite;
    ls.setDepth(LAYER_BASE + (ls.y + ls.height / 2) / FOOT_DIV);
    this.localPlayer.nameTag.setDepth(NAME_DEPTH);

    this.remotePlayers.forEach(rp => {
      rp.sprite.setDepth(LAYER_BASE + (rp.sprite.y + rp.sprite.height / 2) / FOOT_DIV);
      rp.nameTag.setDepth(NAME_DEPTH);
    });

    this._updateWaveEmojis();
  }

  // 1.0 when very close, easing to 0 by the disconnect distance
  _proximityFactor(dist) {
    const FULL = 80; // full volume/opacity within this radius
    return Phaser.Math.Clamp((PROXIMITY_CLOSE_DIST - dist) / (PROXIMITY_CLOSE_DIST - FULL), 0, 1);
  }

  _checkProximity(localZone = this._zoneAt(this.localPlayer.sprite.x, this.localPlayer.sprite.y)) {
    const lx = this.localPlayer.sprite.x;
    const ly = this.localPlayer.sprite.y;
    const nearby = [];

    const dndSelf = this._status === 'dnd';

    this.remotePlayers.forEach((rp, id) => {
      // Do Not Disturb (either side) blocks calls entirely
      if (dndSelf || rp.status === 'dnd') {
        this.webRTC?.closePeer(id);
        return;
      }

      // Authoritative zone the peer reported (not guessed from a lerped sprite)
      const remoteZone = rp.zoneId ?? null;

      if (localZone !== null || remoteZone !== null) {
        // Private-zone rules: a call connects only when BOTH are in the same
        // zone (any distance). One in / one out (or different zones) = no call.
        if (localZone !== null && localZone === remoteZone) {
          nearby.push(rp.name);
          this.webRTC?.onNearby(id, rp.name);
          this.webRTC?.setProximity(id, 1); // full volume + opacity inside a shared room
        } else {
          this.webRTC?.closePeer(id);
        }
      } else {
        // Open grounds: connect within OPEN_DIST, drop beyond CLOSE_DIST, and in
        // between fade audio + video gradually so the call eases out, not cuts.
        const dist = Phaser.Math.Distance.Between(lx, ly, rp.sprite.x, rp.sprite.y);
        if (dist > PROXIMITY_CLOSE_DIST) {
          this.webRTC?.closePeer(id);
        } else if (dist < PROXIMITY_OPEN_DIST || this.webRTC?.hasPeer(id)) {
          nearby.push(rp.name);
          this.webRTC?.onNearby(id, rp.name);
          this.webRTC?.setProximity(id, this._proximityFactor(dist));
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

  // ── waves ─────────────────────────────────────────────────────────────────

  onWaved({ fromName, targetId }) {
    this._showWaveEmoji(targetId);
    if (targetId === this.socket?.id) {
      this._showWaveNotice(fromName);              // in-map banner
      this.webRTC?.notifyWave(fromName);           // OS notification + chime
    }
  }

  // Hand-wave emoji that follows the target avatar's head for ~2 seconds
  _showWaveEmoji(targetId) {
    const sprite = targetId === this.socket?.id
      ? this.localPlayer?.sprite
      : this.remotePlayers.get(targetId)?.sprite;
    if (!sprite) return;
    const txt = this.add.text(sprite.x, sprite.y - 60, '👋', { fontSize: '30px' })
      .setOrigin(0.5, 1).setDepth(NAME_DEPTH + 0.1);
    (this._waveEmojis ||= []).push({ txt, sprite });
    this.time.delayedCall(2000, () => {
      const i = this._waveEmojis.findIndex(w => w.txt === txt);
      if (i >= 0) this._waveEmojis.splice(i, 1);
      txt.destroy();
    });
  }

  // Keep each wave emoji above its avatar's head, with a gentle bob
  _updateWaveEmojis() {
    if (!this._waveEmojis?.length) return;
    const bob = Math.sin(this.time.now / 150) * 3;
    this._waveEmojis.forEach(w => w.txt.setPosition(w.sprite.x, w.sprite.y - 60 + bob));
  }

  _showWaveNotice(fromName) {
    if (!this._waveNotice) return;
    this._waveNotice.setText(`👋 ${fromName} is waving at you!`).setVisible(true);
    this._waveNoticeTimer?.remove();
    this._waveNoticeTimer = this.time.delayedCall(4000, () => this._waveNotice.setVisible(false));
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
    this.pip?.destroy();
    this.postits?.destroy();
    this._hideContextMenu();
    this._waveEmojis?.forEach(w => w.txt.destroy());
  }
}
