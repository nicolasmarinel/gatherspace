import { io } from 'socket.io-client';
import { SERVER_URL } from '../constants.js';

export class SocketManager {
  constructor(scene) {
    this.scene = scene;
    this.socket = null;
    // Throttle move events to ~20/s
    this._lastMoveSent = 0;
    this._pendingMove = null;
    this._moveTimer = null;
    // Stored for reconnect re-join
    this._roomId = null;
    this._name = null;
    this._avatarIndex = null;
    this._sessionId = null;
    this._firstConnect = true;
  }

  _getOrCreateSessionId() {
    const KEY = 'gs-session';
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem(KEY, id);
    }
    return id;
  }

  connect(roomId, name, avatarIndex, x, y) {
    this._roomId = roomId;
    this._name = name;
    this._avatarIndex = avatarIndex;
    this._sessionId = this._getOrCreateSessionId();
    this._firstConnect = true;

    this.socket = io(SERVER_URL, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      console.log('Socket connected:', this.socket.id);
      if (this._firstConnect) {
        this._firstConnect = false;
        this.socket.emit('join-room', {
          roomId, name, avatar: avatarIndex, x, y,
          sessionId: this._sessionId,
        });
      } else {
        // Reconnect after a network blip — clean up stale state then re-join
        console.log('Socket reconnected, re-joining room…');
        this.scene.onSocketReconnect?.();
        this.socket.emit('join-room', {
          roomId: this._roomId,
          name: this._name,
          avatar: this._avatarIndex,
          x: this.scene.localPlayer?.sprite.x ?? x,
          y: this.scene.localPlayer?.sprite.y ?? y,
          sessionId: this._sessionId,
        });
      }
    });

    this.socket.on('room-state', (players) => {
      players.forEach(p => this.scene.addRemotePlayer(p));
    });

    this.socket.on('player-joined', (p) => this.scene.addRemotePlayer(p));

    this.socket.on('player-moved', ({ id, x, y, direction, isMoving, dancing }) => {
      this.scene.updateRemotePlayer(id, x, y, direction, isMoving, dancing);
    });

    this.socket.on('player-left', (id) => this.scene.removeRemotePlayer(id));

    // WebRTC signaling passthrough
    this.socket.on('webrtc-offer',  (d) => this.scene.webRTC?.onOffer(d));
    this.socket.on('webrtc-answer', (d) => this.scene.webRTC?.onAnswer(d));
    this.socket.on('webrtc-ice',    (d) => this.scene.webRTC?.onIceCandidate(d));

    // Screen-share peer signaling passthrough
    this.socket.on('screen-offer',  (d) => this.scene.webRTC?.onScreenOffer(d));
    this.socket.on('screen-answer', (d) => this.scene.webRTC?.onScreenAnswer(d));
    this.socket.on('screen-ice',    (d) => this.scene.webRTC?.onScreenIce(d));

    // Shared map state + live edits
    this.socket.on('map-state',          (m)   => this.scene.onMapState?.(m));
    this.socket.on('map-object-added',   (o)   => this.scene.onMapObjectAdded?.(o));
    this.socket.on('map-object-moved',   (o)   => this.scene.onMapObjectMoved?.(o));
    this.socket.on('map-object-z',       ({ id, z }) => this.scene.onMapObjectZ?.(id, z));
    this.socket.on('map-object-above',   ({ id, above }) => this.scene.onMapObjectAbove?.(id, above));
    this.socket.on('map-object-removed', ({ id }) => this.scene.onMapObjectRemoved?.(id));
    this.socket.on('map-collision',      ({ cells }) => this.scene.onMapCollision?.(cells));

    this.socket.on('disconnect', (reason) => console.log('Socket disconnected:', reason));
    this.socket.on('connect_error', (err) => console.error('Connection error:', err));
  }

  sendMove(x, y, direction, isMoving, dancing = false) {
    const now = Date.now();
    this._pendingMove = { x, y, direction, isMoving, dancing };
    const elapsed = now - this._lastMoveSent;
    if (elapsed >= 50) {
      this._flushMove();
    } else if (!this._moveTimer) {
      // Trailing flush so the final state (e.g. the "stopped" frame) is always
      // delivered — otherwise peers can keep playing the walk animation.
      this._moveTimer = setTimeout(() => this._flushMove(), 50 - elapsed);
    }
  }

  _flushMove() {
    if (this._moveTimer) { clearTimeout(this._moveTimer); this._moveTimer = null; }
    if (!this._pendingMove) return;
    this.socket?.emit('move', this._pendingMove);
    this._lastMoveSent = Date.now();
    this._pendingMove = null;
  }

  sendOffer(targetId, offer)    { this.socket?.emit('webrtc-offer',  { targetId, offer }); }
  sendAnswer(targetId, answer)  { this.socket?.emit('webrtc-answer', { targetId, answer }); }
  sendIce(targetId, candidate)  { this.socket?.emit('webrtc-ice',    { targetId, candidate }); }

  sendScreenOffer(targetId, offer)   { this.socket?.emit('screen-offer',  { targetId, offer }); }
  sendScreenAnswer(targetId, answer) { this.socket?.emit('screen-answer', { targetId, answer }); }
  sendScreenIce(targetId, candidate) { this.socket?.emit('screen-ice',    { targetId, candidate }); }

  // Map editing
  sendMapAdd(obj)       { this.socket?.emit('map-add-object', obj); }
  sendMapMove(obj)      { this.socket?.emit('map-move-object', obj); }
  sendMapZ(id, z)       { this.socket?.emit('map-object-z', { id, z }); }
  sendMapAbove(id, above) { this.socket?.emit('map-object-above', { id, above }); }
  sendMapDelete(id)     { this.socket?.emit('map-delete-object', { id }); }
  sendMapCollision(cells) { this.socket?.emit('map-collision', { cells }); }

  get id() { return this.socket?.id; }

  disconnect() { this.socket?.disconnect(); }
}
