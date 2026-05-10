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
  }

  connect(roomId, name, avatarIndex, x, y) {
    this.socket = io(SERVER_URL, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      console.log('Socket connected:', this.socket.id);
      this.socket.emit('join-room', { roomId, name, avatar: avatarIndex, x, y });
    });

    this.socket.on('room-state', (players) => {
      players.forEach(p => this.scene.addRemotePlayer(p));
    });

    this.socket.on('player-joined', (p) => this.scene.addRemotePlayer(p));

    this.socket.on('player-moved', ({ id, x, y, direction, isMoving }) => {
      this.scene.updateRemotePlayer(id, x, y, direction, isMoving);
    });

    this.socket.on('player-left', (id) => this.scene.removeRemotePlayer(id));

    // WebRTC signaling passthrough
    this.socket.on('webrtc-offer', (d) => this.scene.webRTC?.onOffer(d));
    this.socket.on('webrtc-answer', (d) => this.scene.webRTC?.onAnswer(d));
    this.socket.on('webrtc-ice', (d) => this.scene.webRTC?.onIceCandidate(d));

    this.socket.on('disconnect', () => console.log('Socket disconnected'));
    this.socket.on('connect_error', (err) => console.error('Connection error:', err));
  }

  sendMove(x, y, direction, isMoving) {
    const now = Date.now();
    this._pendingMove = { x, y, direction, isMoving };
    if (now - this._lastMoveSent >= 50) {
      this._flushMove();
    }
  }

  _flushMove() {
    if (!this._pendingMove) return;
    this.socket?.emit('move', this._pendingMove);
    this._lastMoveSent = Date.now();
    this._pendingMove = null;
  }

  sendOffer(targetId, offer) { this.socket?.emit('webrtc-offer', { targetId, offer }); }
  sendAnswer(targetId, answer) { this.socket?.emit('webrtc-answer', { targetId, answer }); }
  sendIce(targetId, candidate) { this.socket?.emit('webrtc-ice', { targetId, candidate }); }

  get id() { return this.socket?.id; }

  disconnect() { this.socket?.disconnect(); }
}
