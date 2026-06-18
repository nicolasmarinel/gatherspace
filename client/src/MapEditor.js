// Live, shared map editor. Open to anyone in the space. All edits go through
// the server (authoritative + persisted) and broadcast to everyone, so the
// scene's onMap* handlers do the actual rendering — this class only drives the
// UI and turns pointer gestures into socket edits.

import gatherMap from './gatherMap.js';

function mk(tag, css = '') {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css.replace(/\s+/g, ' ').trim();
  return el;
}

// Distinct fill colors for private zones in the editor overlay
const ZONE_COLORS = [0x8b5cf6, 0x10b981, 0xf59e0b, 0xec4899, 0x06b6d4, 0xef4444, 0x84cc16, 0xa855f7];

export class MapEditor {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.mode = 'objects';       // 'objects' | 'collisions'
    this.brush = null;           // object filename to place, or null = select/move
    this.erase = false;          // collision sub-mode
    this.selectedId = null;
    this._drag = null;           // active object drag
    this._pan = null;            // active camera pan-drag
    this._painting = false;
    this._paintBatch = [];
    this._zonePending = new Set(); // tiles for the zone currently being drawn
    this._zoneLabels = [];         // Phaser text labels for zone names
    this._zonePainting = false;
    this._undoStack = [];          // local edit history
    this._redoStack = [];          // entries undone, available to redo
    this._pendingRefs = new Map(); // ref -> history entry awaiting its server id

    this._buildToggle();
    this._buildToolbar();
    this._buildPalette();
    this._overlay = scene.add.graphics().setDepth(8);

    // Pointer + key wiring (handlers no-op unless active)
    this._onDown = (p) => this._pointerDown(p);
    this._onMove = (p) => this._pointerMove(p);
    this._onUp = (p) => this._pointerUp(p);
    scene.input.on('pointerdown', this._onDown);
    scene.input.on('pointermove', this._onMove);
    scene.input.on('pointerup', this._onUp);
    this._onKey = (e) => this._keydown(e);
    document.addEventListener('keydown', this._onKey);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _buildToggle() {
    // The editor is entered from the bottom bar's hammer; this button is kept
    // (hidden) only so enter()/exit() can update it without extra null checks.
    this._toggle = mk('button', 'display:none;');
    document.body.appendChild(this._toggle);
  }

  _buildToolbar() {
    this._bar = mk('div', `
      position:fixed; top:0; left:0; right:0; z-index:150; display:none;
      align-items:center; gap:10px; padding:8px 14px;
      background:#0f172aee; border-bottom:1px solid #334155;
      font-family:monospace; color:#e2e8f0; font-size:13px;
    `);

    const title = mk('span', 'font-weight:bold; color:#60a5fa;');
    title.textContent = '🛠 Map Maker';

    // Mode tabs
    this._tabObjects = this._tab('Objects', () => this.setMode('objects'));
    this._tabColl = this._tab('Collision Zones', () => this.setMode('collisions'));
    this._tabZones = this._tab('Private Zones', () => this.setMode('zones'));

    // Undo / redo (works across object / collision / zone placements)
    this._undoBtn = this._btn('↶ Undo', () => this.undo());
    this._redoBtn = this._btn('↷ Redo', () => this.redo());

    // Object tools
    this._delBtn = this._btn('🗑 Delete', () => this.deleteSelected());
    // Avatar-relative layer controls (0 = same layer as avatars / y-sorted)
    this._layerDownBtn = this._btn('▽ layer', () => this._changeLayer(-1));
    this._layerLabel = mk('span', 'font-family:monospace;font-size:12px;color:#94a3b8;min-width:78px;text-align:center;');
    this._layerLabel.textContent = 'vs avatar: –';
    this._layerUpBtn = this._btn('△ layer', () => this._changeLayer(1));

    // Collision tools
    this._paintBtn = this._btn('🟥 Paint', () => { this.erase = false; this._syncTools(); });
    this._eraseBtn = this._btn('⬜ Erase', () => { this.erase = true; this._syncTools(); });

    // Zone tools
    this._zoneNameInput = mk('input', `
      background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:6px;
      padding:5px 8px; font-family:monospace; font-size:12px; width:120px;
    `);
    this._zoneNameInput.type = 'text';
    this._zoneNameInput.placeholder = 'Zone name';
    this._zoneNameInput.maxLength = 40;
    // Keep keystrokes from reaching Phaser's keyboard (so WASD types normally)
    this._zoneNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._saveZone(); }
      else if (e.key === 'Escape') this._zoneNameInput.blur();
      e.stopPropagation();
    });
    this._zoneSaveBtn = this._btn('💾 Save zone', () => this._saveZone());
    this._zoneClearBtn = this._btn('Clear', () => this._clearZone());
    this._zoneSelect = mk('select', `
      background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:6px;
      padding:5px; font-family:monospace; font-size:12px;
    `);
    this._zoneSelect.addEventListener('change', () => this._populateOwnerOptions());
    this._zoneDelBtn = this._btn('🗑 Delete zone', () => this._deleteSelectedZone());
    // Claim controls (administrators only) — assign a zone's owner
    this._zoneOwnerSelect = mk('select', `
      background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:6px;
      padding:5px; font-family:monospace; font-size:12px; max-width:170px;
    `);
    this._zoneClaimBtn = this._btn('Set owner', () => this._setZoneOwner());

    this._hint = mk('span', 'color:#64748b; flex:1;');

    const exit = this._btn('✓ Done', () => this.exit());
    exit.style.marginLeft = 'auto';

    this._bar.append(title, this._tabObjects, this._tabColl, this._tabZones, this._undoBtn, this._redoBtn,
      this._delBtn, this._layerDownBtn, this._layerLabel, this._layerUpBtn,
      this._paintBtn, this._eraseBtn,
      this._zoneNameInput, this._zoneSaveBtn, this._zoneClearBtn,
      this._zoneSelect, this._zoneDelBtn, this._zoneOwnerSelect, this._zoneClaimBtn,
      this._hint, exit);
    document.body.appendChild(this._bar);
  }

  _tab(label, fn) {
    const b = this._btn(label, fn);
    b.dataset.tab = '1';
    return b;
  }

  _btn(label, fn) {
    const b = mk('button', `
      background:#1e293b; border:1px solid #334155; color:#e2e8f0;
      font-family:monospace; font-size:12px; padding:6px 10px; border-radius:8px; cursor:pointer;
    `);
    b.textContent = label;
    b.addEventListener('click', () => { fn(); b.blur(); });
    return b;
  }

  _buildPalette() {
    this._palette = mk('div', `
      position:fixed; top:46px; left:0; bottom:0; width:132px; z-index:150; display:none;
      background:#0f172aee; border-right:1px solid #334155; overflow-y:auto; padding:8px;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);

    // "Select / move" mode (no brush)
    const selectBtn = mk('button', `
      width:100%; background:#1e293b; border:1px solid #334155; color:#e2e8f0;
      font-family:monospace; font-size:12px; padding:8px; border-radius:8px; cursor:pointer;
      margin-bottom:8px;
    `);
    selectBtn.textContent = '↖ Select / Move';
    selectBtn.addEventListener('click', () => this.setBrush(null));
    this._palette.appendChild(selectBtn);

    const grid = mk('div', 'display:flex; flex-wrap:wrap; gap:6px; justify-content:center;');
    this._paletteItems = new Map();
    gatherMap.images.forEach(f => {
      const cell = mk('div', `
        width:52px; height:52px; border:2px solid transparent; border-radius:6px;
        background:#1e293b; cursor:pointer; display:flex; align-items:center; justify-content:center;
        overflow:hidden;
      `);
      cell.title = f;
      const img = document.createElement('img');
      img.src = `/objects/${f}`;
      img.style.cssText = 'max-width:48px; max-height:48px; image-rendering:pixelated;';
      cell.appendChild(img);
      cell.addEventListener('click', () => this.setBrush(f));
      this._paletteItems.set(f, cell);
      grid.appendChild(cell);
    });
    this._palette.appendChild(grid);
    document.body.appendChild(this._palette);
  }

  // ── mode / tool state ───────────────────────────────────────────────────────

  enter() {
    this.active = true;
    this.scene._beginManualPan();
    this._toggle.textContent = '✓ Done';
    this._toggle.style.background = '#14532d';
    this._bar.style.display = 'flex';
    this._refreshZoneList();
    this._refreshUndoBtn();
    this.setMode(this.mode);
  }

  exit() {
    this.active = false;
    this.deselect();
    this._painting = false; this._drag = null; this._pan = null;
    this._zonePainting = false;
    this._zonePending.clear();
    this._toggle.textContent = '🛠 Edit Map';
    this._toggle.style.background = '#1e293b';
    this._bar.style.display = 'none';
    this._palette.style.display = 'none';
    this._overlay.clear();
    this._clearZoneLabels();
    this.scene._resumeFollow();
  }

  setMode(mode) {
    this.mode = mode;
    this.deselect();
    this._palette.style.display = (mode === 'objects') ? 'block' : 'none';
    if (mode === 'zones') this._refreshZoneList();
    this._syncTools();
    this.redrawOverlay();
  }

  setBrush(f) {
    this.brush = f;
    this.deselect();
    this._paletteItems.forEach((cell, key) =>
      cell.style.borderColor = (key === f) ? '#3b82f6' : 'transparent');
    this._syncTools();
  }

  _syncTools() {
    const obj = this.mode === 'objects';
    const coll = this.mode === 'collisions';
    const zon = this.mode === 'zones';
    const hl = (b, on) => b.style.background = on ? '#1e3a5f' : '#1e293b';
    hl(this._tabObjects, obj); hl(this._tabColl, coll); hl(this._tabZones, zon);

    // Object tools
    this._delBtn.style.display = obj ? '' : 'none';
    this._delBtn.disabled = !this.selectedId;
    this._delBtn.style.opacity = this.selectedId ? '1' : '0.5';
    const sel = this.selectedId ? this.scene.mapObjects.get(this.selectedId)?.getData('obj') : null;
    [this._layerDownBtn, this._layerUpBtn].forEach(b => {
      b.style.display = obj ? '' : 'none';
      b.disabled = !sel;
      b.style.opacity = sel ? '1' : '0.5';
    });
    this._layerLabel.style.display = obj ? '' : 'none';
    const ly = sel ? (sel.layer || 0) : null;
    this._layerLabel.textContent = ly === null ? 'vs avatar: –'
      : (ly === 0 ? 'same as avatar' : `${ly > 0 ? '+' : ''}${ly} vs avatar`);

    // Collision tools
    this._paintBtn.style.display = coll ? '' : 'none';
    this._eraseBtn.style.display = coll ? '' : 'none';
    this._paintBtn.style.background = this.erase ? '#1e293b' : '#1e3a5f';
    this._eraseBtn.style.background = this.erase ? '#1e3a5f' : '#1e293b';

    // Zone tools
    [this._zoneNameInput, this._zoneSaveBtn, this._zoneClearBtn, this._zoneSelect, this._zoneDelBtn]
      .forEach(el => el.style.display = zon ? '' : 'none');
    // Claim controls are admin-only
    const showClaim = zon && this.scene._isAdmin();
    this._zoneOwnerSelect.style.display = showClaim ? '' : 'none';
    this._zoneClaimBtn.style.display = showClaim ? '' : 'none';

    this._hint.style.color = '#64748b';
    if (obj) {
      this._hint.textContent = this.brush
        ? 'Click to place · pick "Select / Move" to edit existing'
        : 'Click an object to select · drag to move · empty drag pans';
    } else if (coll) {
      this._hint.textContent = 'Drag over tiles to ' + (this.erase ? 'clear' : 'add') + ' collision';
    } else {
      this._hint.textContent = 'Name it, drag contiguous tiles, then Save zone · WASD/arrows pan';
    }
  }

  // ── selection ───────────────────────────────────────────────────────────────

  selectObject(id) {
    this.deselect();
    const img = this.scene.mapObjects.get(id);
    if (!img) return;
    this.selectedId = id;
    img.setTint(0x66aaff);
    this._syncTools();
  }

  deselect() {
    if (this.selectedId) {
      const img = this.scene.mapObjects.get(this.selectedId);
      img?.clearTint();
    }
    this.selectedId = null;
    if (this._delBtn) this._syncTools();
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const o = this.scene.mapObjects.get(this.selectedId)?.getData('obj');
    if (o && !this.scene.canEditTile(o.x, o.y)) { this._flash('That area is claimed'); return; }
    if (o) this._pushUndo({ kind: 'delete-object', id: null, obj: { f: o.f, x: o.x, y: o.y, ox: o.ox || 0, oy: o.oy || 0, z: o.z || 0, layer: o.layer || 0 } });
    this.scene.socket?.sendMapDelete(this.selectedId);
    this.deselect();
  }

  _changeLayer(delta) {
    if (!this.selectedId) return;
    const o = this.scene.mapObjects.get(this.selectedId)?.getData('obj');
    if (!o) return;
    if (!this.scene.canEditTile(o.x, o.y)) { this._flash('That area is claimed'); return; }
    const next = Math.max(-4, Math.min(4, (o.layer || 0) + delta));
    if (next !== (o.layer || 0)) {
      this._pushUndo({ kind: 'layer-object', id: this.selectedId, prevLayer: o.layer || 0, nextLayer: next });
      this.scene.socket?.sendMapLayer(this.selectedId, next);
    }
  }

  // ── pointer interactions ─────────────────────────────────────────────────────

  _tileAt(wx, wy) {
    const T = this.scene._mapTile;
    const col = Math.floor(wx / T), row = Math.floor(wy / T);
    return { col, row, index: row * this.scene._mapTilesW + col };
  }

  _hitTest(wx, wy) {
    let best = null, bestDepth = -Infinity;
    this.scene.mapObjects.forEach((img, id) => {
      const b = img.getBounds();
      if (wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom && img.depth > bestDepth) {
        best = id; bestDepth = img.depth;
      }
    });
    return best;
  }

  _pointerDown(p) {
    if (!this.active) return;
    const wx = p.worldX, wy = p.worldY;

    if (this.mode === 'collisions') {
      this._painting = true;
      this._paintBatch = [];
      this._paintUndo = []; // previous solid state of each painted cell
      this._paintAt(wx, wy);
      return;
    }

    if (this.mode === 'zones') {
      this._zonePainting = true;
      this._paintZoneAt(wx, wy);
      return;
    }

    // objects mode
    if (this.brush) {
      const { col, row } = this._tileAt(wx, wy);
      if (!this.scene.canEditTile(col, row)) { this._flash('That area is claimed'); return; }
      const ref = this._newRef();
      this.scene.socket?.sendMapAdd({ f: this.brush, x: col, y: row, ox: 0, oy: 0, layer: 0, ref });
      this._pushUndo(this._registerRef(ref, {
        kind: 'add-object', obj: { f: this.brush, x: col, y: row, ox: 0, oy: 0, z: 0, layer: 0 },
      }));
      return;
    }

    const hit = this._hitTest(wx, wy);
    if (hit) {
      this.selectObject(hit);
      const img = this.scene.mapObjects.get(hit);
      const o = img.getData('obj');
      // Selection is allowed for viewing, but you can only drag objects you may edit
      if (this.scene.canEditTile(o.x, o.y)) {
        this._drag = { id: hit, offX: wx - img.x, offY: wy - img.y, moved: false,
          prev: { x: o.x, y: o.y, ox: o.ox || 0, oy: o.oy || 0 } };
      }
    } else {
      this.deselect();
      this._pan = { x: p.x, y: p.y };
    }
  }

  _pointerMove(p) {
    if (!this.active) return;

    if (this._painting) { this._paintAt(p.worldX, p.worldY); return; }
    if (this._zonePainting) { this._paintZoneAt(p.worldX, p.worldY); return; }

    if (this._drag) {
      const img = this.scene.mapObjects.get(this._drag.id);
      if (img) {
        img.setPosition(p.worldX - this._drag.offX, p.worldY - this._drag.offY);
        img.setDepth(this.scene._objDepthFor(img, img.getData('obj')));
        this._drag.moved = true;
      }
      return;
    }

    if (this._pan) {
      const cam = this.scene.cameras.main;
      cam.scrollX -= (p.x - this._pan.x) / cam.zoom;
      cam.scrollY -= (p.y - this._pan.y) / cam.zoom;
      this._pan = { x: p.x, y: p.y };
    }
  }

  _pointerUp() {
    if (!this.active) return;

    if (this._painting) {
      this._painting = false;
      if (this._paintBatch.length) {
        this.scene.socket?.sendMapCollision(this._paintBatch);
        // Per-cell prev (undo) + next (redo) state
        const cells = this._paintUndo.map((u, idx) => ({ i: u.i, prev: u.solid, next: this._paintBatch[idx].solid }));
        this._pushUndo({ kind: 'collision', cells });
      }
      this._paintBatch = [];
      this._paintUndo = [];
      return;
    }

    if (this._zonePainting) { this._zonePainting = false; return; }

    if (this._drag) {
      const img = this.scene.mapObjects.get(this._drag.id);
      if (img && this._drag.moved) {
        const o = img.getData('obj');
        const T = this.scene._mapTile;
        const x = Math.round((img.x - (o.ox || 0)) / T);
        const y = Math.round((img.y - (o.oy || 0)) / T);
        // Don't allow dropping into a claimed area you can't edit; snap back instead
        if (this.scene.canEditTile(x, y)) {
          this.scene.socket?.sendMapMove({ id: this._drag.id, x, y, ox: o.ox || 0, oy: o.oy || 0 });
          this._pushUndo({ kind: 'move-object', id: this._drag.id,
            prev: this._drag.prev, next: { x, y, ox: o.ox || 0, oy: o.oy || 0 } });
        } else {
          img.setPosition(o.x * T + (o.ox || 0), o.y * T + (o.oy || 0));
          img.setDepth(this.scene._objDepthFor(img, o));
          this._flash('That area is claimed');
        }
      }
      this._drag = null;
      return;
    }

    this._pan = null;
  }

  // Paint/erase a single tile (optimistic local apply + batched send on pointerup)
  _paintAt(wx, wy) {
    const { col, row, index } = this._tileAt(wx, wy);
    if (col < 0 || row < 0 || col >= this.scene._mapTilesW || row >= this.scene._mapTilesH) return;
    const state = this.scene.collisionState;
    if (!state) return;
    const solid = this.erase ? 0 : 1;
    if (state[index] === solid) return;
    this._paintUndo?.push({ i: index, solid: state[index] }); // remember prior state
    state[index] = solid;
    if (solid) this.scene._addCollisionZone(index); else this.scene._removeCollisionZone(index);
    this._paintBatch.push({ i: index, solid });
    this.redrawOverlay();
  }

  // ── private zones ───────────────────────────────────────────────────────────

  _paintZoneAt(wx, wy) {
    const { col, row, index } = this._tileAt(wx, wy);
    if (col < 0 || row < 0 || col >= this.scene._mapTilesW || row >= this.scene._mapTilesH) return;
    this._zonePending.add(index);
    this.redrawOverlay();
  }

  _clearZone() { this._zonePending.clear(); this.redrawOverlay(); }

  // 4-connectivity flood fill to confirm the selected tiles form one region
  _isContiguous(cells) {
    if (!cells.length) return false;
    const set = new Set(cells);
    const W = this.scene._mapTilesW, H = this.scene._mapTilesH;
    const seen = new Set([cells[0]]);
    const stack = [cells[0]];
    while (stack.length) {
      const idx = stack.pop();
      const col = idx % W, row = Math.floor(idx / W);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const nc = col + dx, nr = row + dy;
        if (nc < 0 || nr < 0 || nc >= W || nr >= H) return;
        const n = nr * W + nc;
        if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      });
    }
    return seen.size === set.size;
  }

  _saveZone() {
    const cells = [...this._zonePending];
    const name = (this._zoneNameInput.value || '').trim();
    if (!name) { this._flash('Name the zone first'); return; }
    if (!cells.length) { this._flash('Paint the zone tiles first'); return; }
    if (!this._isContiguous(cells)) { this._flash('Tiles must form one contiguous area'); return; }
    const ref = this._newRef();
    this.scene.socket?.sendZoneAdd(name, cells, ref);
    this._pushUndo(this._registerRef(ref, { kind: 'add-zone', name, cells: [...cells] }));
    this._zonePending.clear();
    this._zoneNameInput.value = '';
    this.redrawOverlay();
    this._flash('Zone saved ✓', '#86efac');
  }

  _deleteSelectedZone() {
    const id = Number(this._zoneSelect.value);
    if (!id) return;
    const z = (this.scene.zones || []).find(zz => zz.id === id);
    if (z) this._pushUndo({ kind: 'delete-zone', id: null, name: z.name, cells: [...z.cells] });
    this.scene.socket?.sendZoneDelete(id);
  }

  _setZoneOwner() {
    const id = Number(this._zoneSelect.value);
    if (!id) return;
    this.scene.socket?.sendZoneClaim(id, this._zoneOwnerSelect.value || null);
  }

  _refreshZoneList() {
    const sel = this._zoneSelect;
    if (!sel) return;
    sel.innerHTML = '';
    const zones = this.scene.zones || [];
    if (!zones.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(no zones)';
      sel.appendChild(o);
    } else {
      zones.forEach(z => {
        const o = document.createElement('option');
        o.value = z.id;
        o.textContent = z.name + (z.owner ? ` · ${z.owner}` : '') + (z.locked ? ' 🔒' : '');
        sel.appendChild(o);
      });
    }
    this._populateOwnerOptions();
  }

  // Owner dropdown: unclaimed / me / everyone in the roster, reflecting the
  // currently-selected zone's owner.
  _populateOwnerOptions() {
    const sel = this._zoneOwnerSelect;
    if (!sel) return;
    const zone = (this.scene.zones || []).find(z => String(z.id) === this._zoneSelect.value);
    sel.innerHTML = '';
    const add = (val, text) => { const o = document.createElement('option'); o.value = val; o.textContent = text; sel.appendChild(o); };
    add('', '(unclaimed)');
    const me = (this.scene.email || '').toLowerCase();
    if (me) add(me, `Me (${me})`);
    (this.scene.webRTC?._presence || []).forEach(u => {
      if (u.email && u.email !== me) add(u.email, `${u.name} (${u.email})`);
    });
    if (zone?.owner && ![...sel.options].some(o => o.value === zone.owner)) add(zone.owner, zone.owner);
    sel.value = zone?.owner || '';
  }

  onZonesReloaded() {
    // Always keep the zone list current (the dropdown is hidden outside zones
    // mode anyway); only the overlay is mode-specific.
    this._refreshZoneList();
    this.redrawOverlay();
  }

  _flash(msg, color = '#fca5a5') {
    this._hint.textContent = msg;
    this._hint.style.color = color;
  }

  // ── undo ────────────────────────────────────────────────────────────────────

  _newRef() { return 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // Register an add-style entry whose server id arrives later (via _resolveRef)
  _registerRef(ref, entry) {
    entry.ref = ref; entry.id = null;
    this._pendingRefs.set(ref, entry);
    return entry;
  }

  _resolveRef(ref, id) {
    const e = this._pendingRefs.get(ref);
    if (e) { e.id = id; this._pendingRefs.delete(ref); }
  }

  _pushUndo(entry) {
    this._undoStack.push(entry);
    if (this._undoStack.length > 60) this._undoStack.shift();
    this._redoStack = []; // a new edit invalidates the redo chain
    this._refreshUndoBtn();
  }

  _refreshUndoBtn() {
    const set = (btn, has) => { if (btn) { btn.disabled = !has; btn.style.opacity = has ? '1' : '0.5'; } };
    set(this._undoBtn, this._undoStack.length > 0);
    set(this._redoBtn, this._redoStack.length > 0);
  }

  // Re-create an object/zone (server assigns a new id, tracked back onto the entry)
  _applyObjAdd(e) { const ref = this._newRef(); this._registerRef(ref, e); this.scene.socket?.sendMapAdd({ ...e.obj, ref }); }
  _applyObjDelete(e) { if (e.id) { this.scene.socket?.sendMapDelete(e.id); e.id = null; } }
  _applyZoneAdd(e) { const ref = this._newRef(); this._registerRef(ref, e); this.scene.socket?.sendZoneAdd(e.name, e.cells, ref); }
  _applyZoneDelete(e) { if (e.id) { this.scene.socket?.sendZoneDelete(e.id); e.id = null; } }

  // Apply a history entry in a direction ('undo' restores the prior state,
  // 'redo' re-applies the original edit). The server still enforces permissions.
  _runOp(e, dir) {
    const s = this.scene.socket;
    const undo = dir === 'undo';
    switch (e.kind) {
      case 'add-object':    undo ? this._applyObjDelete(e) : this._applyObjAdd(e); break;
      case 'delete-object': undo ? this._applyObjAdd(e) : this._applyObjDelete(e); break;
      case 'move-object': {
        const p = undo ? e.prev : e.next;
        s?.sendMapMove({ id: e.id, x: p.x, y: p.y, ox: p.ox, oy: p.oy });
        break;
      }
      case 'layer-object': s?.sendMapLayer(e.id, undo ? e.prevLayer : e.nextLayer); break;
      case 'collision': {
        const cells = e.cells.map(c => ({ i: c.i, solid: undo ? c.prev : c.next }));
        if (cells.length) s?.sendMapCollision(cells);
        break;
      }
      case 'add-zone':    undo ? this._applyZoneDelete(e) : this._applyZoneAdd(e); break;
      case 'delete-zone': undo ? this._applyZoneAdd(e) : this._applyZoneDelete(e); break;
    }
  }

  undo() {
    const e = this._undoStack.pop();
    if (!e) { this._flash('Nothing to undo'); this._refreshUndoBtn(); return; }
    if ((e.kind === 'add-object' || e.kind === 'add-zone') && !e.id) {
      // add not yet acknowledged by the server — put it back and bail
      this._undoStack.push(e); this._flash('Undo not ready yet'); return;
    }
    this._runOp(e, 'undo');
    this._redoStack.push(e);
    this._refreshUndoBtn();
  }

  redo() {
    const e = this._redoStack.pop();
    if (!e) { this._flash('Nothing to redo'); this._refreshUndoBtn(); return; }
    this._runOp(e, 'redo');
    this._undoStack.push(e);
    this._refreshUndoBtn();
  }

  _clearZoneLabels() {
    this._zoneLabels.forEach(t => t.destroy());
    this._zoneLabels = [];
  }

  _keydown(e) {
    if (!this.active) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
      e.preventDefault();
      this.deleteSelected();
    } else if (e.key === 'Escape') {
      this.exit();
    }
  }

  // Pan with the movement keys while editing
  updatePan(delta) {
    if (!this.active) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const cam = this.scene.cameras.main;
    const c = this.scene.cursors, w = this.scene.wasd;
    const sp = 12 * (delta / 16) / cam.zoom;
    let dx = 0, dy = 0;
    if (c.left.isDown || w.left.isDown) dx -= sp;
    if (c.right.isDown || w.right.isDown) dx += sp;
    if (c.up.isDown || w.up.isDown) dy -= sp;
    if (c.down.isDown || w.down.isDown) dy += sp;
    if (dx) cam.scrollX += dx;
    if (dy) cam.scrollY += dy;
  }

  // ── collision overlay ─────────────────────────────────────────────────────

  redrawOverlay() {
    const g = this._overlay;
    g.clear();
    this._clearZoneLabels();
    if (!this.active) return;
    const T = this.scene._mapTile, W = this.scene._mapTilesW, H = this.scene._mapTilesH;
    if (!T) return;

    if (this.mode === 'collisions' && this.scene.collisionState) {
      g.lineStyle(1, 0xffffff, 0.12);
      for (let c = 0; c <= W; c++) g.lineBetween(c * T, 0, c * T, H * T);
      for (let r = 0; r <= H; r++) g.lineBetween(0, r * T, W * T, r * T);
      g.fillStyle(0xef4444, 0.35);
      const st = this.scene.collisionState;
      for (let i = 0; i < st.length; i++) {
        if (st[i]) g.fillRect((i % W) * T, Math.floor(i / W) * T, T, T);
      }
      return;
    }

    if (this.mode === 'zones') {
      g.lineStyle(1, 0xffffff, 0.10);
      for (let c = 0; c <= W; c++) g.lineBetween(c * T, 0, c * T, H * T);
      for (let r = 0; r <= H; r++) g.lineBetween(0, r * T, W * T, r * T);
      (this.scene.zones || []).forEach((z, zi) => {
        g.fillStyle(ZONE_COLORS[zi % ZONE_COLORS.length], 0.35);
        let sx = 0, sy = 0;
        z.cells.forEach(i => {
          const cx = i % W, cy = Math.floor(i / W);
          g.fillRect(cx * T, cy * T, T, T);
          sx += cx; sy += cy;
        });
        if (z.cells.length) {
          const lx = (sx / z.cells.length + 0.5) * T;
          const ly = (sy / z.cells.length + 0.5) * T;
          const text = z.name + (z.locked ? ' 🔒' : '') + (z.owner ? `\nclaimed: ${z.owner}` : '');
          const label = this.scene.add.text(lx, ly, text, {
            fontSize: '14px', color: '#fff', fontFamily: 'monospace', align: 'center',
            backgroundColor: '#000000aa', padding: { x: 4, y: 2 },
          }).setOrigin(0.5).setDepth(8.3);
          this._zoneLabels.push(label);
        }
      });
      // pending (new) zone in bright yellow
      g.fillStyle(0xfacc15, 0.5);
      this._zonePending.forEach(i => g.fillRect((i % W) * T, Math.floor(i / W) * T, T, T));
    }
  }

  // Called after a full map reload (e.g., reconnect) to refresh the overlay
  onMapReloaded() {
    if (this.active) { this._refreshZoneList(); this.redrawOverlay(); }
  }

  destroy() {
    this.scene.input.off('pointerdown', this._onDown);
    this.scene.input.off('pointermove', this._onMove);
    this.scene.input.off('pointerup', this._onUp);
    document.removeEventListener('keydown', this._onKey);
    this._clearZoneLabels();
    this._toggle?.remove();
    this._bar?.remove();
    this._palette?.remove();
    this._overlay?.destroy();
  }
}
