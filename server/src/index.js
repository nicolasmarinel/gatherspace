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
      return { identity: payload.sub, name: payload.name, email };
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
    z: p.z || 0, above: !!p.above,
  }));
  let maxId = 0;
  placements.forEach(p => { const n = parseInt(String(p.id).replace(/\D/g, ''), 10); if (n > maxId) maxId = n; });
  return { dims: m.dims, tile: m.tile, collisions: col, placements, nextId: maxId + 1 };
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
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerData = null;

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
      direction: 'down', isMoving: false, sessionId: identity,
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
  });

  // ── map editing (shared across everyone; broadcast to all incl. sender) ──
  socket.on('map-add-object', ({ f, x, y, ox, oy, z, above }) => {
    if (typeof f !== 'string') return;
    const obj = { id: `o${mapState.nextId++}`, f, x: x | 0, y: y | 0, ox: ox || 0, oy: oy || 0, z: z || 0, above: !!above };
    mapState.placements.push(obj);
    io.emit('map-object-added', obj);
    scheduleSave();
  });

  socket.on('map-move-object', ({ id, x, y, ox, oy }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj) return;
    obj.x = x | 0; obj.y = y | 0;
    if (ox !== undefined) obj.ox = ox;
    if (oy !== undefined) obj.oy = oy;
    io.emit('map-object-moved', { id, x: obj.x, y: obj.y, ox: obj.ox, oy: obj.oy });
    scheduleSave();
  });

  socket.on('map-object-z', ({ id, z }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj || typeof z !== 'number') return;
    obj.z = z;
    io.emit('map-object-z', { id, z });
    scheduleSave();
  });

  socket.on('map-object-above', ({ id, above }) => {
    const obj = mapState.placements.find(p => p.id === id);
    if (!obj) return;
    obj.above = !!above;
    io.emit('map-object-above', { id, above: obj.above });
    scheduleSave();
  });

  socket.on('map-delete-object', ({ id }) => {
    const i = mapState.placements.findIndex(p => p.id === id);
    if (i === -1) return;
    mapState.placements.splice(i, 1);
    io.emit('map-object-removed', { id });
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

  socket.on('move', ({ x, y, direction, isMoving, dancing }) => {
    if (!currentRoom || !playerData) return;
    playerData.x = x;
    playerData.y = y;
    playerData.direction = direction;
    playerData.isMoving = isMoving;
    playerData.dancing = dancing;
    socket.to(currentRoom).emit('player-moved', { id: socket.id, x, y, direction, isMoving, dancing });
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
    console.log(`[${currentRoom}] ${playerData?.name} left`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`GatherSpace server listening on :${PORT}`);
});
