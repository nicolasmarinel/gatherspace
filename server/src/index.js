const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');

// Google sign-in (optional). When GOOGLE_CLIENT_ID is set, join requests must
// carry a valid Google ID token; the verified `sub` is the authoritative
// identity used for dedup, and the email is checked against the allowlist.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || process.env.VITE_ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
console.log(`Auth: ${googleClient ? 'Google sign-in required' : 'open (guest)'}; allowlist: ${ALLOWED_EMAILS.length || 'none'}`);

// Administrators — the only accounts that may assign claimed zones.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ||
  'nicolas.marinel@gmail.com,nicolasm@paperstreetmedia.com,stomper6@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = (email) => !!email && ADMIN_EMAILS.includes(email);

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve the built Vite client in production
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms: Map<roomId, Map<socketId, playerData>>
const rooms = new Map();

// Remove (and disconnect) any socket already present under the same identity,
// so one account can never occupy two slots. Scans the live room state, so it
// can't be defeated by a stale lookup table.
function evictIdentity(identity, exceptSocketId) {
  if (!identity) return;
  for (const [rId, room] of rooms) {
    for (const [sid, pdata] of [...room]) {
      if (sid !== exceptSocketId && pdata.sessionId === identity) {
        room.delete(sid);
        io.to(rId).emit('player-left', sid);
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.disconnect(true);
        console.log(`[${rId}] Evicted duplicate session ${sid} for identity`);
      }
    }
    if (room.size === 0) rooms.delete(rId);
  }
}

// Resolve the trusted identity for a join. With Google configured, the ID token
// must verify (and pass the allowlist); the verified sub is the identity. If the
// token is missing/expired but the client supplies a sessionId (e.g. a reconnect
// after the ~1h token TTL), fall back to it so long sessions aren't kicked.
async function resolveIdentity({ idToken, sessionId }) {
  if (googleClient && idToken) {
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      const email = (payload.email || '').toLowerCase();
      if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(email)) {
        return { error: 'not-allowed' };
      }
      return { identity: payload.sub, name: payload.name, email, picture: payload.picture };
    } catch (e) {
      // Expired/invalid token: only accept the client sessionId as a fallback
      if (sessionId) return { identity: sessionId };
      return { error: 'invalid-token' };
    }
  }
  if (googleClient && !idToken) {
    return sessionId ? { identity: sessionId } : { error: 'auth-required' };
  }
  return { identity: sessionId || null }; // guest / dev (no Google configured)
}

// ── shared, editable map state ──────────────────────────────────────────────
// Authoritative across all clients. Persisted to a (Railway-volume) directory
// so edits survive restarts/redeploys. Set MAP_DATA_DIR to the volume mount.
const DATA_DIR = process.env.MAP_DATA_DIR || path.join(__dirname, '../data');
const MAP_FILE = path.join(DATA_DIR, 'map.json');
const SEED_FILE = path.join(__dirname, '../seedMap.json');

function normalizeMap(m) {
  let col = m.collisions;
  if (typeof col === 'string') col = Array.from(Buffer.from(col, 'base64'));
  const placements = (m.placements || []).map((p, i) => ({
    id: p.id || `o${i}`, f: p.f, x: p.x, y: p.y, ox: p.ox || 0, oy: p.oy || 0,
    z: p.z || 0,
    // Avatar-relative layer: 0 y-sorts with avatars, <0 below, >0 above.
    // Migrate the old boolean `above` (true -> +1, false -> -1).
    layer: Number.isInteger(p.layer) ? p.layer : (p.above ? 1 : -1),
  }));
  let maxId = 0;
  placements.forEach(p => { const n = parseInt(String(p.id).replace(/\D/g, ''), 10); if (n > maxId) maxId = n; });
  // Private zones: named, contiguous tile groups
  const zones = (m.zones || []).map((z, i) => ({
    id: z.id ?? i + 1, name: String(z.name || `Zone ${i + 1}`).slice(0, 40),
    cells: Array.isArray(z.cells) ? z.cells.filter(Number.isInteger) : [],
    locked: !!z.locked,
    owner: z.owner ? String(z.owner).toLowerCase() : null, // claimed-zone owner email
  }));
  const nextZoneId = zones.reduce((mx, z) => Math.max(mx, z.id), 0) + 1;
  return { dims: m.dims, tile: m.tile, collisions: col, placements, zones, nextId: maxId + 1, nextZoneId };
}

function loadMap() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      console.log('Loading saved map from', MAP_FILE);
      return normalizeMap(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')));
    }
  } catch (e) { console.error('Map load failed, using seed:', e.message); }
  return normalizeMap(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
}

const mapState = loadMap();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(MAP_FILE, JSON.stringify({
        dims: mapState.dims, tile: mapState.tile,
        collisions: Buffer.from(Uint8Array.from(mapState.collisions)).toString('base64'),
        placements: mapState.placements,
        zones: mapState.zones,
      }));
    } catch (e) { console.error('Map save failed:', e.message); }
  }, 1000);
}

// Compact payload sent to clients on join
function mapPayload() {
  return {
    dims: mapState.dims, tile: mapState.tile,
    collisions: Buffer.from(Uint8Array.from(mapState.collisions)).toString('base64'),
    placements: mapState.placements,
    zones: mapState.zones,
  };
}

// ── presence + direct messages ──────────────────────────────────────────────
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
function loadJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('Load failed', file, e.message); }
  return fallback;
}
const profiles = new Map(Object.entries(loadJson(PROFILES_FILE, {}))); // email -> { name, picture }
const dmConvos = loadJson(DMS_FILE, {});       // convKey -> [{ from, text, ts }]
const onlineByEmail = new Map();               // email -> Set<socketId>

let profSaveT = null, dmSaveT = null;
function saveProfiles() {
  if (profSaveT) return;
  profSaveT = setTimeout(() => {
    profSaveT = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PROFILES_FILE, JSON.stringify(Object.fromEntries(profiles))); }
    catch (e) { console.error('Save profiles failed:', e.message); }
  }, 1000);
}
function saveDMs() {
  if (dmSaveT) return;
  dmSaveT = setTimeout(() => {
    dmSaveT = null;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DMS_FILE, JSON.stringify(dmConvos)); }
    catch (e) { console.error('Save DMs failed:', e.message); }
  }, 1000);
}
const convKey = (a, b) => [a, b].sort().join('|');

// Roster = allowlist ∪ everyone who has ever signed in, with live online flags
function rosterPayload() {
  const emails = new Set([...ALLOWED_EMAILS, ...profiles.keys()]);
  return [...emails].map(email => {
    const p = profiles.get(email) || {};
    return { email, name: p.name || email, picture: p.picture || '', online: (onlineByEmail.get(email)?.size || 0) > 0 };
  });
}
function broadcastPresence() { io.emit('presence', rosterPayload()); }

// Is any connected player currently inside this zone?
function zoneOccupied(zoneId) {
  for (const room of rooms.values()) {
    for (const pd of room.values()) {
      if (pd.zone === zoneId) return true;
    }
  }
  return false;
}

// Safeguard: a locked zone auto-unlocks once everyone has left it (walked out
// or disconnected), so a locker who reloads can't lock themselves (and others) out.
function releaseZoneIfEmpty(zoneId) {
  if (zoneId == null) return;
  const z = mapState.zones.find(zz => zz.id === zoneId);
  if (z && z.locked && !zoneOccupied(zoneId)) {
    z.locked = false;
    io.emit('map-zone-locked', { id: zoneId, locked: false });
    scheduleSave();
    console.log(`Zone ${zoneId} auto-unlocked (empty)`);
  }
}

// Owner email of the claimed zone covering a tile, or null if unclaimed.
function ownerOfTile(tx, ty) {
  if (!mapState.dims) return null;
  const idx = ty * mapState.dims[0] + tx;
  for (const z of mapState.zones) if (z.owner && z.cells.includes(idx)) return z.owner;
  return null;
}
// Can this user edit an object at this tile? (free tile, the zone's owner, or an admin)
function canEditTile(email, tx, ty) {
  const owner = ownerOfTile(tx, ty);
  return !owner || owner === email || isAdmin(email);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerData = null;
  let myEmail = null; // set once the join is authenticated

  socket.on('join-room', async ({ roomId, name, avatar, x, y, sessionId, idToken }) => {
    const res = await resolveIdentity({ idToken, sessionId });
    if (res.error) {
      socket.emit('auth-error', res.error);
      socket.disconnect(true);
      return;
    }
    const identity = res.identity;

    // One account = one slot: remove/disconnect any other socket with this id.
    evictIdentity(identity, socket.id);

    currentRoom = roomId;
    playerData = {
      id: socket.id, name: name || res.name, avatar, x, y,
      direction: 'down', isMoving: false, zone: null, sessionId: identity,
    };

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Send snapshot of existing players to the newcomer
    socket.emit('room-state', Array.from(room.values()));

    room.set(socket.id, playerData);
    socket.join(roomId);
    socket.to(roomId).emit('player-joined', playerData);

    console.log(`[${roomId}] ${playerData.name} joined (${socket.id}), room size: ${room.size}`);

    // Send the current shared map to the newcomer
    socket.emit('map-state', mapPayload());

    // Presence + profile registry (only for authenticated users with an email)
    if (res.email) {
      myEmail = res.email;
      profiles.set(myEmail, { name: playerData.name, picture: res.picture || profiles.get(myEmail)?.picture || '' });
      saveProfiles();
      if (!onlineByEmail.has(myEmail)) onlineByEmail.set(myEmail, new Set());
      onlineByEmail.get(myEmail).add(socket.id);
      broadcastPresence();
    } else {
      socket.emit('presence', rosterPayload());
    }
  });

  // ── direct messages ──
  socket.on('dm-history', ({ peer }) => {
    if (!myEmail || !peer) return;
    socket.emit('dm-history', { peer, messages: dmConvos[convKey(myEmail, peer)] || [] });
  });

  socket.on('dm-send', ({ to, text }) => {
    if (!myEmail || !to || typeof text !== 'string' || !text.trim()) return;
    const msg = { from: myEmail, text: text.trim().slice(0, 2000), ts: Date.now() };
    const key = convKey(myEmail, to);
    if (!dmConvos[key]) dmConvos[key] = [];
    dmConvos[key].push(msg);
    if (dmConvos[key].length > 500) dmConvos[key] = dmConvos[key].slice(-500);
    saveDMs();
    // deliver to the recipient (peer = sender, from their view)
    onlineByEmail.get(to)?.forEach(sid => io.to(sid).emit('dm-message', { peer: myEmail, msg }));
    // echo to all of the sender's own sockets (peer = recipient, from sender view)
    onlineByEmail.get(myEmail)?.forEach(sid => io.to(sid).emit('dm-message', { peer: to, msg }));
  });

  // ── map editing (shared across everyone; broadcast to all incl. sender) ──
  socket.on('map-add-object', ({ f, x, y, ox, oy, z, layer, ref }) => {
    if (typeof f !== 'string') return;
    if (!canEditTile(myEmail, x | 0, y | 0)) return; // claimed-zone: owner only
    const obj = { id: `o${mapState.nextId++}`, f, x: x | 0, y: y | 0, ox: ox || 0, oy: oy || 0, z: z || 0, layer: Number.isInteger(layer) ? layer : 0 };
    mapState.placements.push(obj);
    io.emit('map-object-added', { ...obj, _ref: ref }); // _ref lets the sender map this to its undo entry
    scheduleSave();
  });

  socket.on('map-move-object', ({ id, x, y, ox, oy }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj) return;
    // Owner-only for claimed zones: can't take an object from one, or drop into one
    if (!canEditTile(myEmail, obj.x, obj.y) || !canEditTile(myEmail, x | 0, y | 0)) return;
    obj.x = x | 0; obj.y = y | 0;
    if (ox !== undefined) obj.ox = ox;
    if (oy !== undefined) obj.oy = oy;
    io.emit('map-object-moved', { id, x: obj.x, y: obj.y, ox: obj.ox, oy: obj.oy });
    scheduleSave();
  });

  socket.on('map-object-z', ({ id, z }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj || typeof z !== 'number') return;
    if (!canEditTile(myEmail, obj.x, obj.y)) return;
    obj.z = z;
    io.emit('map-object-z', { id, z });
    scheduleSave();
  });

  socket.on('map-object-layer', ({ id, layer }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj || !Number.isInteger(layer)) return;
    if (!canEditTile(myEmail, obj.x, obj.y)) return;
    obj.layer = Math.max(-4, Math.min(4, layer));
    io.emit('map-object-layer', { id, layer: obj.layer });
    scheduleSave();
  });

  socket.on('map-delete-object', ({ id }) => {
    const i = mapState.placements.findIndex(p => p.id === id);
    if (i === -1) return;
    if (!canEditTile(myEmail, mapState.placements[i].x, mapState.placements[i].y)) return;
    mapState.placements.splice(i, 1);
    io.emit('map-object-removed', { id });
    scheduleSave();
  });

  socket.on('map-zone-add', ({ name, cells, ref }) => {
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(cells) || !cells.length) return;
    const zone = {
      id: mapState.nextZoneId++,
      name: name.trim().slice(0, 40),
      cells: cells.filter(Number.isInteger),
      locked: false, owner: null,
    };
    mapState.zones.push(zone);
    io.emit('map-zone-added', { ...zone, _ref: ref });
    scheduleSave();
  });

  socket.on('map-zone-delete', ({ id }) => {
    const i = mapState.zones.findIndex(z => z.id === id);
    if (i === -1) return;
    mapState.zones.splice(i, 1);
    io.emit('map-zone-removed', { id });
    scheduleSave();
  });

  socket.on('map-zone-lock', ({ id, locked }) => {
    const z = mapState.zones.find(z => z.id === id);
    if (!z) return;
    // A claimed zone can only be locked/unlocked by its owner (or an admin)
    if (z.owner && z.owner !== myEmail && !isAdmin(myEmail)) return;
    z.locked = !!locked;
    io.emit('map-zone-locked', { id, locked: z.locked });
    scheduleSave();
  });

  // Assign / clear a claimed zone's owner — administrators only
  socket.on('map-zone-claim', ({ id, owner }) => {
    if (!isAdmin(myEmail)) return;
    const z = mapState.zones.find(z => z.id === id);
    if (!z) return;
    z.owner = owner ? String(owner).toLowerCase().slice(0, 120) : null;
    io.emit('map-zone-claimed', { id, owner: z.owner });
    scheduleSave();
  });

  socket.on('map-collision', ({ cells }) => {
    if (!Array.isArray(cells)) return;
    const n = mapState.collisions.length;
    const applied = [];
    cells.forEach(c => {
      if (c && c.i >= 0 && c.i < n) {
        mapState.collisions[c.i] = c.solid ? 1 : 0;
        applied.push({ i: c.i, solid: c.solid ? 1 : 0 });
      }
    });
    if (applied.length) { io.emit('map-collision', { cells: applied }); scheduleSave(); }
  });

  socket.on('move', ({ x, y, direction, isMoving, dancing, zone }) => {
    if (!currentRoom || !playerData) return;
    const prevZone = playerData.zone;
    playerData.x = x;
    playerData.y = y;
    playerData.direction = direction;
    playerData.isMoving = isMoving;
    playerData.dancing = dancing;
    playerData.zone = zone ?? null; // authoritative private-zone membership
    socket.to(currentRoom).emit('player-moved', { id: socket.id, x, y, direction, isMoving, dancing, zone: playerData.zone });
    // Left a (locked) zone? Auto-unlock it if it's now empty.
    if (prevZone != null && prevZone !== playerData.zone) releaseZoneIfEmpty(prevZone);
  });

  // Wave at another player: tell the whole room to show the wave emoji above the
  // target avatar; the target client also self-notifies (banner / chime / OS).
  socket.on('wave', ({ targetId }) => {
    if (!currentRoom || !playerData) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.has(targetId)) return;
    io.to(currentRoom).emit('waved', { fromId: socket.id, fromName: playerData.name, targetId });
  });

  // WebRTC signaling relay — server is a pure passthrough
  socket.on('webrtc-offer',  ({ targetId, offer })     => io.to(targetId).emit('webrtc-offer',  { fromId: socket.id, offer }));
  socket.on('webrtc-answer', ({ targetId, answer })    => io.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer }));
  socket.on('webrtc-ice',    ({ targetId, candidate }) => io.to(targetId).emit('webrtc-ice',    { fromId: socket.id, candidate }));

  // Screen-share peer connections use separate signaling events
  socket.on('screen-offer',  ({ targetId, offer })     => io.to(targetId).emit('screen-offer',  { fromId: socket.id, offer }));
  socket.on('screen-answer', ({ targetId, answer })    => io.to(targetId).emit('screen-answer', { fromId: socket.id, answer }));
  socket.on('screen-ice',    ({ targetId, candidate }) => io.to(targetId).emit('screen-ice',    { fromId: socket.id, candidate }));

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(currentRoom);
    }
    io.to(currentRoom).emit('player-left', socket.id);
    if (myEmail) {
      const set = onlineByEmail.get(myEmail);
      if (set) { set.delete(socket.id); if (!set.size) onlineByEmail.delete(myEmail); }
      broadcastPresence();
    }
    // Auto-unlock the zone this player was in if they were the last one there
    releaseZoneIfEmpty(playerData?.zone);
    console.log(`[${currentRoom}] ${playerData?.name} left`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`GatherSpace server listening on :${PORT}`);
});
