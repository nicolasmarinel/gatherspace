const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms: Map<roomId, Map<socketId, playerData>>
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerData = null;

  socket.on('join-room', ({ roomId, name, avatar, x, y }) => {
    currentRoom = roomId;
    playerData = { id: socket.id, name, avatar, x, y, direction: 'down', isMoving: false };

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Send snapshot of existing players to the newcomer
    socket.emit('room-state', Array.from(room.values()));

    room.set(socket.id, playerData);
    socket.join(roomId);
    socket.to(roomId).emit('player-joined', playerData);

    console.log(`[${roomId}] ${name} joined (${socket.id}), room size: ${room.size}`);
  });

  socket.on('move', ({ x, y, direction, isMoving }) => {
    if (!currentRoom || !playerData) return;
    playerData.x = x;
    playerData.y = y;
    playerData.direction = direction;
    playerData.isMoving = isMoving;
    socket.to(currentRoom).emit('player-moved', { id: socket.id, x, y, direction, isMoving });
  });

  // WebRTC signaling relay — server is a pure passthrough
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc-offer', { fromId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer });
  });

  socket.on('webrtc-ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice', { fromId: socket.id, candidate });
  });

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
