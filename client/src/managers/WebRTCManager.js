// Manages proximity-based WebRTC peer connections.
// STUN handles most cases. Open Relay TURN covers strict-NAT (two home routers).
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const TILE_W = 128;
const TILE_H = 96;

// How many grid columns for N participants in the expanded view
function gridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4; // up to 10
}

export class WebRTCManager {
  constructor(socketManager, localName = 'You') {
    this.socket = socketManager;
    this.localName = localName;
    this.peers = new Map();     // peerId -> { pc, stream, audioEl, filmTile }
    this.peerNames = new Map(); // peerId -> string
    this.localStream = null;

    this.audioMuted = false;
    this.videoHidden = false;
    this.selfViewHidden = false;
    this._expandedOpen = false;

    this._buildShell();
    this._requestMedia();
  }

  // ── DOM shell ─────────────────────────────────────────────────────────────

  _buildShell() {
    // Filmstrip — bottom-left corner
    this._filmstrip = mk('div', `
      position:fixed; bottom:14px; left:14px; z-index:100;
      display:flex; gap:8px; flex-wrap:wrap; max-width:680px; align-items:flex-end;
    `);

    // Local tile is always first
    this._localTile = this._makeTile(null, this.localName, true);
    this._filmstrip.appendChild(this._localTile.wrapper);
    document.body.appendChild(this._filmstrip);

    // Control bar — bottom-center
    this._bar = mk('div', `
      position:fixed; bottom:14px; left:50%; transform:translateX(-50%); z-index:100;
      display:flex; gap:6px; background:#1e293b; border:1px solid #334155;
      border-radius:14px; padding:8px 14px; align-items:center;
    `);

    this._muteBtn  = this._ctrlBtn('🎤', 'Mute mic',       () => this._toggleMute());
    this._camBtn   = this._ctrlBtn('📷', 'Hide camera',    () => this._toggleCam());
    this._selfBtn  = this._ctrlBtn('👁️', 'Hide self-view', () => this._toggleSelf());
    this._bar.append(this._muteBtn, this._camBtn, this._selfBtn);
    document.body.appendChild(this._bar);

    // Status badge — top-right
    this._status = mk('div', `
      position:fixed; top:14px; right:14px; z-index:100;
      background:#1e293b; border:1px solid #334155; border-radius:8px;
      font-family:monospace; font-size:12px; padding:6px 10px; color:#64748b;
    `);
    this._status.textContent = '🎤 Requesting media…';
    document.body.appendChild(this._status);

    // Expanded overlay — hidden until a tile is clicked
    this._overlay = mk('div', `
      position:fixed; inset:0; background:#000000cc; z-index:200;
      display:none; align-items:center; justify-content:center;
    `);
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) this._closeExpanded();
    });
    document.body.appendChild(this._overlay);
  }

  // ── tile factory ──────────────────────────────────────────────────────────

  // Returns { wrapper, video }. Clicking any tile opens the expanded grid.
  _makeTile(stream, name, isLocal) {
    const wrapper = mk('div', `
      position:relative; border-radius:10px; overflow:hidden;
      background:#0f172a; border:2px solid #334155;
      width:${TILE_W}px; height:${TILE_H}px; cursor:pointer; flex-shrink:0;
    `);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio always goes through a separate <audio> el
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    if (stream) video.srcObject = stream;

    const label = mk('div', `
      position:absolute; bottom:0; left:0; right:0;
      background:#000000bb; font-family:monospace; font-size:10px;
      color:#e2e8f0; padding:3px 6px; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis;
    `);
    label.textContent = isLocal ? `${name} (you)` : name;

    wrapper.append(video, label);
    wrapper.addEventListener('click', () => this._openExpanded());
    return { wrapper, video };
  }

  // ── control buttons ───────────────────────────────────────────────────────

  _ctrlBtn(icon, title, onClick) {
    const btn = mk('button', `
      background:none; border:none; font-size:20px; cursor:pointer;
      padding:4px 8px; border-radius:8px; line-height:1; transition:background .15s;
    `);
    btn.title = title;
    btn.textContent = icon;
    btn.addEventListener('mouseenter', () => { if (!btn._active) btn.style.background = '#334155'; });
    btn.addEventListener('mouseleave', () => { if (!btn._active) btn.style.background = 'none'; });
    btn.addEventListener('click', onClick);
    return btn;
  }

  _setActive(btn, active, activeIcon, inactiveIcon) {
    btn._active = active;
    btn.textContent = active ? activeIcon : inactiveIcon;
    btn.style.background = active ? '#7f1d1d' : 'none';
  }

  // ── controls ──────────────────────────────────────────────────────────────

  _toggleMute() {
    this.audioMuted = !this.audioMuted;
    this.localStream?.getAudioTracks().forEach(t => t.enabled = !this.audioMuted);
    this._setActive(this._muteBtn, this.audioMuted, '🔇', '🎤');
  }

  _toggleCam() {
    this.videoHidden = !this.videoHidden;
    this.localStream?.getVideoTracks().forEach(t => t.enabled = !this.videoHidden);
    this._setActive(this._camBtn, this.videoHidden, '🚫', '📷');
    // Grey out the local tile video when cam is off
    if (this._localTile?.video) {
      this._localTile.video.style.opacity = this.videoHidden ? '0' : '1';
    }
  }

  _toggleSelf() {
    this.selfViewHidden = !this.selfViewHidden;
    this._setActive(this._selfBtn, this.selfViewHidden, '🙈', '👁️');
    if (this._localTile?.wrapper) {
      this._localTile.wrapper.style.display = this.selfViewHidden ? 'none' : 'block';
    }
    // Refresh expanded view if open so self tile appears/disappears there too
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  // ── expanded grid ─────────────────────────────────────────────────────────

  _openExpanded() {
    this._expandedOpen = true;
    this._buildExpandedGrid();
    this._overlay.style.display = 'flex';
  }

  _closeExpanded() {
    this._expandedOpen = false;
    this._overlay.innerHTML = '';
    this._overlay.style.display = 'none';
  }

  _buildExpandedGrid() {
    this._overlay.innerHTML = '';

    // Collect all participants
    const participants = [];
    if (!this.selfViewHidden && this.localStream) {
      participants.push({ stream: this.localStream, name: `${this.localName} (you)` });
    }
    this.peers.forEach((peer, id) => {
      if (peer.stream) {
        participants.push({ stream: peer.stream, name: this.peerNames.get(id) || 'Player' });
      }
    });

    if (participants.length === 0) {
      const msg = mk('div', 'font-family:monospace;color:#64748b;font-size:16px;');
      msg.textContent = 'No one nearby yet — walk up to someone!';
      this._overlay.appendChild(msg);
      this._appendCloseBtn();
      return;
    }

    const cols = gridCols(participants.length);

    const grid = mk('div', `
      display:grid;
      grid-template-columns:repeat(${cols},1fr);
      gap:10px;
      width:min(92vw,1280px);
      max-height:88vh;
      overflow-y:auto;
      padding:4px;
    `);

    participants.forEach(({ stream, name }) => {
      const cell = mk('div', `
        position:relative; border-radius:12px; overflow:hidden;
        background:#0f172a; border:2px solid #334155; aspect-ratio:16/9;
      `);

      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true;
      vid.srcObject = stream;
      vid.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';

      const label = mk('div', `
        position:absolute; bottom:0; left:0; right:0;
        background:#000000bb; font-family:monospace; font-size:13px;
        color:#e2e8f0; padding:6px 10px;
      `);
      label.textContent = name;

      cell.append(vid, label);
      grid.appendChild(cell);
    });

    this._overlay.appendChild(grid);
    this._appendCloseBtn();
  }

  _appendCloseBtn() {
    const btn = mk('button', `
      position:fixed; top:20px; right:24px; z-index:201;
      background:#334155; border:none; color:#e2e8f0;
      font-size:20px; width:40px; height:40px; border-radius:50%;
      cursor:pointer; display:flex; align-items:center; justify-content:center;
    `);
    btn.textContent = '✕';
    btn.addEventListener('click', () => this._closeExpanded());
    this._overlay.appendChild(btn);
  }

  // ── media ─────────────────────────────────────────────────────────────────

  async _requestMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this._localTile.video.srcObject = this.localStream;
      this._setStatus('🟢 Camera + mic ready', '#86efac');
    } catch {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._setStatus('🎤 Audio only', '#fde68a');
      } catch {
        this._setStatus('❌ No media access', '#fca5a5');
      }
    }
  }

  _setStatus(text, color) {
    this._status.textContent = text;
    this._status.style.color = color;
  }

  // ── proximity (called by GameScene) ───────────────────────────────────────

  onNearby(peerId, name) {
    if (name) this.peerNames.set(peerId, name);
    if (this.peers.has(peerId) || !this.localStream) return;
    // Only the socket with the lexicographically smaller ID initiates,
    // preventing both sides from sending an offer simultaneously.
    if ((this.socket.id ?? '') < peerId) this._initiatePeer(peerId);
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl?.remove();
    peer.filmTile?.wrapper.remove();
    this.peers.delete(peerId);
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  setVolume(peerId, vol) {
    const peer = this.peers.get(peerId);
    if (peer?.audioEl) peer.audioEl.volume = Math.max(0, Math.min(1, vol));
  }

  // ── peer connections ──────────────────────────────────────────────────────

  _makePeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.sendIce(peerId, candidate);
    };
    pc.ontrack = ({ streams }) => this._attachRemoteStream(peerId, streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closePeer(peerId);
      }
    };
    return pc;
  }

  _initiatePeer(peerId) {
    const pc = this._makePeerConnection(peerId);
    this.peers.set(peerId, { pc, stream: null, audioEl: null, filmTile: null });
    this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    pc.createOffer()
      .then(o => pc.setLocalDescription(o).then(() => o))
      .then(o => this.socket.sendOffer(peerId, o))
      .catch(console.error);
  }

  _attachRemoteStream(peerId, stream) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.stream) return;
    peer.stream = stream;

    const name = this.peerNames.get(peerId) || 'Player';
    const tile = this._makeTile(stream, name, false);
    peer.filmTile = tile;
    this._filmstrip.appendChild(tile.wrapper);

    // Separate <audio> element carries the actual audio (video el is always muted)
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = stream;
    document.body.appendChild(audioEl);
    peer.audioEl = audioEl;

    if (this._expandedOpen) this._buildExpandedGrid();
  }

  // ── signaling ─────────────────────────────────────────────────────────────

  async onOffer({ fromId, offer }) {
    if (this.peers.has(fromId) || !this.localStream) return;
    const pc = this._makePeerConnection(fromId);
    this.peers.set(fromId, { pc, stream: null, audioEl: null, filmTile: null });
    this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.sendAnswer(fromId, answer);
  }

  async onAnswer({ fromId, answer }) {
    const peer = this.peers.get(fromId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async onIceCandidate({ fromId, candidate }) {
    const peer = this.peers.get(fromId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch { /* benign if ICE already settled */ }
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this.peers.forEach((_, id) => this.closePeer(id));
    this.localStream?.getTracks().forEach(t => t.stop());
    this._filmstrip?.remove();
    this._bar?.remove();
    this._status?.remove();
    this._overlay?.remove();
  }
}

// Tiny DOM helper — creates an element and sets its inline style in one call
function mk(tag, css = '') {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css.replace(/\s+/g, ' ').trim();
  return el;
}
