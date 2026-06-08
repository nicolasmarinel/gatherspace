const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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
// sessions: Map<sessionId, { socketId, roomId }> — evict stale reconnects
const sessions = new Map();

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

  socket.on('join-room', ({ roomId, name, avatar, x, y, sessionId }) => {
    // Evict any stale connection sharing the same sessionId (e.g. after a network blip)
    if (sessionId && sessions.has(sessionId)) {
      const prev = sessions.get(sessionId);
      if (prev.socketId !== socket.id) {
        const prevRoom = rooms.get(prev.roomId);
        if (prevRoom) {
          prevRoom.delete(prev.socketId);
          if (prevRoom.size === 0) rooms.delete(prev.roomId);
        }
        io.to(prev.roomId).emit('player-left', prev.socketId);
        console.log(`[${prev.roomId}] Evicted stale session for ${name} (${prev.socketId})`);
      }
    }

    currentRoom = roomId;
    playerData = { id: socket.id, name, avatar, x, y, direction: 'down', isMoving: false, sessionId };

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Send snapshot of existing players to the newcomer
    socket.emit('room-state', Array.from(room.values()));

    room.set(socket.id, playerData);
    socket.join(roomId);
    socket.to(roomId).emit('player-joined', playerData);

    if (sessionId) sessions.set(sessionId, { socketId: socket.id, roomId });
    console.log(`[${roomId}] ${name} joined (${socket.id}), room size: ${room.size}`);

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
    // Only remove the session entry if this socket is still the owner
    // (a reconnect may have already replaced it with a new socketId)
    if (playerData?.sessionId) {
      const sess = sessions.get(playerData.sessionId);
      if (sess?.socketId === socket.id) sessions.delete(playerData.sessionId);
    }
    io.to(currentRoom).emit('player-left', socket.id);
    console.log(`[${currentRoom}] ${playerData?.name} left`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`GatherSpace server listening on :${PORT}`);
});
