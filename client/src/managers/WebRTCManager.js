// Manages proximity-based WebRTC peer connections.
// Chat uses RTCDataChannel — peer-to-peer, automatically scoped to nearby players.
// STUN handles most networks; Open Relay TURN covers strict-NAT home routers.

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

const VIDEO_QUALITIES = {
  sd:  { label: 'SD  (320×240)',       w: 320,  h: 240  },
  hd:  { label: 'HD  (1280×720)',      w: 1280, h: 720  },
  fhd: { label: 'Full HD  (1920×1080)', w: 1920, h: 1080 },
};

const TILE_W = 128;
const TILE_H = 96;

function gridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4; // up to 10
}

export class WebRTCManager {
  constructor(socketManager, localName = 'You') {
    this.socket     = socketManager;
    this.localName  = localName;
    this.peers      = new Map();  // peerId -> { pc, stream, audioEl, filmTile, dc }
    this.peerNames  = new Map();  // peerId -> string
    this.localStream = null;

    this.audioMuted    = false;
    this.videoHidden   = false;
    this.selfViewHidden = false;
    this._expandedOpen = false;
    this._settingsEl   = null;
    this.currentQuality = localStorage.getItem('gs-video-quality') || 'sd';

    this._buildShell();
    this._requestMedia();
  }

  // ── DOM shell ─────────────────────────────────────────────────────────────

  _buildShell() {
    // Filmstrip — bottom-left
    this._filmstrip = mk('div', `
      position:fixed; bottom:14px; left:14px; z-index:100;
      display:flex; gap:8px; flex-wrap:wrap; max-width:680px; align-items:flex-end;
    `);
    this._localTile = this._makeTile(null, this.localName, true);
    this._filmstrip.appendChild(this._localTile.wrapper);
    document.body.appendChild(this._filmstrip);

    // Fixed control bar — bottom-center
    this._bar = mk('div', `
      position:fixed; bottom:14px; left:50%; transform:translateX(-50%); z-index:100;
      display:flex; gap:6px; background:#1e293b; border:1px solid #334155;
      border-radius:14px; padding:8px 14px; align-items:center;
    `);
    this._bar.append(
      this._ctrlBtn('🎤', 'Mute mic',        'mute', () => this._toggleMute()),
      this._ctrlBtn('📷', 'Hide camera',     'cam',  () => this._toggleCam()),
      this._ctrlBtn('👁️', 'Hide self-view',  'self', () => this._toggleSelf()),
      mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
      this._ctrlBtn('⚙️', 'Settings',        '',     () => this._openSettings()),
    );
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
      display:none; flex-direction:column;
    `);
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) this._closeExpanded();
    });
    document.body.appendChild(this._overlay);

    // Chat panel — bottom-right, hidden until peers connect
    this._buildChatPanel();
  }

  // ── tile factory ──────────────────────────────────────────────────────────

  _makeTile(stream, name, isLocal) {
    const wrapper = mk('div', `
      position:relative; border-radius:10px; overflow:hidden;
      background:#0f172a; border:2px solid #334155;
      width:${TILE_W}px; height:${TILE_H}px; cursor:pointer; flex-shrink:0;
      transition:border-color .2s;
    `);
    wrapper.addEventListener('mouseenter', () => wrapper.style.borderColor = '#60a5fa');
    wrapper.addEventListener('mouseleave', () => wrapper.style.borderColor = '#334155');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio is handled by a separate <audio> el
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

  // ── control button factory ────────────────────────────────────────────────

  // data-gs-ctrl is used by _syncControlBtns() to find all instances
  // (both in the fixed bar and inside the expanded overlay header).
  _ctrlBtn(icon, title, ctrlKey, onClick) {
    const btn = mk('button', `
      background:none; border:none; font-size:20px; cursor:pointer;
      padding:4px 8px; border-radius:8px; line-height:1;
      transition:background .15s; color:inherit;
    `);
    btn.title = title;
    btn.textContent = icon;
    if (ctrlKey) btn.dataset.gsCtrl = ctrlKey;
    btn.addEventListener('mouseenter', () => { if (!btn.dataset.active) btn.style.background = '#334155'; });
    btn.addEventListener('mouseleave', () => { if (!btn.dataset.active) btn.style.background = 'none'; });
    btn.addEventListener('click', onClick);
    this._applyCtrlState(btn); // reflect current state immediately
    return btn;
  }

  _applyCtrlState(btn) {
    const map = {
      mute: [this.audioMuted,     '🔇', '🎤'],
      cam:  [this.videoHidden,    '🚫', '📷'],
      self: [this.selfViewHidden, '🙈', '👁️'],
    };
    const entry = map[btn.dataset.gsCtrl];
    if (!entry) return;
    const [active, on, off] = entry;
    btn.textContent = active ? on : off;
    btn.style.background = active ? '#7f1d1d' : 'none';
    btn.dataset.active = active ? '1' : '';
  }

  // Refresh every control button anywhere in the document
  _syncControlBtns() {
    document.querySelectorAll('[data-gs-ctrl]').forEach(b => this._applyCtrlState(b));
  }

  // ── toggle actions ────────────────────────────────────────────────────────

  _toggleMute() {
    this.audioMuted = !this.audioMuted;
    this.localStream?.getAudioTracks().forEach(t => t.enabled = !this.audioMuted);
    this._syncControlBtns();
  }

  _toggleCam() {
    this.videoHidden = !this.videoHidden;
    this.localStream?.getVideoTracks().forEach(t => t.enabled = !this.videoHidden);
    if (this._localTile?.video) this._localTile.video.style.opacity = this.videoHidden ? '0' : '1';
    this._syncControlBtns();
  }

  _toggleSelf() {
    this.selfViewHidden = !this.selfViewHidden;
    if (this._localTile?.wrapper) {
      this._localTile.wrapper.style.display = this.selfViewHidden ? 'none' : 'block';
    }
    this._syncControlBtns();
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  // ── expanded overlay ──────────────────────────────────────────────────────

  _openExpanded() {
    this._expandedOpen = true;
    this._overlay.style.display = 'flex';
    this._buildExpandedGrid();
  }

  _closeExpanded() {
    this._expandedOpen = false;
    this._overlay.innerHTML = '';
    this._overlay.style.display = 'none';
  }

  _buildExpandedGrid() {
    this._overlay.innerHTML = '';

    // ── Header: controls + close ──
    const header = mk('div', `
      display:flex; align-items:center; gap:6px; padding:10px 16px;
      background:#1e293bdd; border-bottom:1px solid #334155; flex-shrink:0;
    `);
    // Recreate the three toggles inside the overlay — _syncControlBtns() keeps them in sync
    header.append(
      this._ctrlBtn('🎤', 'Mute mic',       'mute', () => this._toggleMute()),
      this._ctrlBtn('📷', 'Hide camera',    'cam',  () => this._toggleCam()),
      this._ctrlBtn('👁️', 'Hide self-view', 'self', () => this._toggleSelf()),
      this._ctrlBtn('⚙️', 'Settings',       '',     () => this._openSettings()),
    );
    const spacer = mk('div', 'flex:1;');
    const closeBtn = mk('button', `
      background:#334155; border:none; color:#e2e8f0; font-size:18px;
      width:36px; height:36px; border-radius:50%; cursor:pointer;
    `);
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this._closeExpanded());
    header.append(spacer, closeBtn);

    // ── Video grid ──
    const participants = [];
    if (!this.selfViewHidden && this.localStream) {
      participants.push({ stream: this.localStream, name: `${this.localName} (you)` });
    }
    this.peers.forEach((peer, id) => {
      if (peer.stream) {
        participants.push({ stream: peer.stream, name: this.peerNames.get(id) || 'Player' });
      }
    });

    let body;
    if (participants.length === 0) {
      body = mk('div', `
        flex:1; display:flex; align-items:center; justify-content:center;
        font-family:monospace; color:#64748b; font-size:15px;
      `);
      body.textContent = 'No one nearby — walk up to someone!';
    } else {
      const cols = gridCols(participants.length);
      body = mk('div', `
        flex:1; overflow-y:auto; padding:14px;
        display:grid; grid-template-columns:repeat(${cols},1fr);
        gap:10px; align-content:start;
      `);
      participants.forEach(({ stream, name }) => {
        const cell = mk('div', `
          position:relative; border-radius:12px; overflow:hidden;
          background:#0f172a; border:2px solid #334155; aspect-ratio:16/9;
        `);
        const vid = document.createElement('video');
        vid.autoplay = true; vid.playsInline = true; vid.muted = true;
        vid.srcObject = stream;
        vid.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        const lbl = mk('div', `
          position:absolute; bottom:0; left:0; right:0;
          background:#000000bb; font-family:monospace;
          font-size:13px; color:#e2e8f0; padding:6px 10px;
        `);
        lbl.textContent = name;
        cell.append(vid, lbl);
        body.appendChild(cell);
      });
    }

    this._overlay.append(header, body);
  }

  // ── settings modal ────────────────────────────────────────────────────────

  _openSettings() {
    if (this._settingsEl) return;

    const modal = mk('div', `
      position:fixed; inset:0; background:#000000aa; z-index:300;
      display:flex; align-items:center; justify-content:center;
    `);
    modal.addEventListener('click', e => { if (e.target === modal) this._closeSettings(); });

    const panel = mk('div', `
      background:#1e293b; border:1px solid #334155; border-radius:16px;
      padding:24px; width:320px; font-family:monospace; color:#e2e8f0;
    `);

    // Title row
    const titleRow = mk('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;');
    const title = mk('div', 'font-size:16px;font-weight:bold;');
    title.textContent = '⚙️  Settings';
    const xBtn = mk('button', `
      background:#334155;border:none;color:#e2e8f0;font-size:14px;
      width:28px;height:28px;border-radius:50%;cursor:pointer;
    `);
    xBtn.textContent = '✕';
    xBtn.addEventListener('click', () => this._closeSettings());
    titleRow.append(title, xBtn);

    // Quality section
    const sectionLabel = mk('div', 'font-size:11px;color:#64748b;letter-spacing:.05em;margin-bottom:10px;');
    sectionLabel.textContent = 'VIDEO QUALITY';

    const options = mk('div', 'display:flex;flex-direction:column;gap:6px;');
    Object.entries(VIDEO_QUALITIES).forEach(([key, { label }]) => {
      const isActive = key === this.currentQuality;
      const row = mk('label', `
        display:flex; align-items:center; gap:10px; padding:10px 12px;
        border-radius:8px; cursor:pointer;
        border:1px solid ${isActive ? '#3b82f6' : '#334155'};
        background:${isActive ? '#1e3a5f' : 'transparent'};
        transition:all .15s;
      `);
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gs-quality';
      radio.value = key;
      radio.checked = isActive;
      radio.style.accentColor = '#3b82f6';
      radio.addEventListener('change', () => {
        if (radio.checked) this._changeQuality(key).then(() => this._closeSettings());
      });
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.fontSize = '14px';
      row.append(radio, lbl);
      options.appendChild(row);
    });

    const note = mk('div', 'font-size:11px;color:#475569;margin-top:14px;line-height:1.5;');
    note.textContent = 'HD/Full HD requires a camera that supports it. Higher resolution uses more bandwidth.';

    panel.append(titleRow, sectionLabel, options, note);
    modal.appendChild(panel);
    document.body.appendChild(modal);
    this._settingsEl = modal;
  }

  _closeSettings() {
    this._settingsEl?.remove();
    this._settingsEl = null;
  }

  async _changeQuality(quality) {
    if (quality === this.currentQuality) return;
    const { w, h } = VIDEO_QUALITIES[quality];
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: w }, height: { ideal: h } },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      // Swap the video track in the existing local stream
      this.localStream?.getVideoTracks().forEach(t => {
        this.localStream.removeTrack(t);
        t.stop();
      });
      this.localStream?.addTrack(newTrack);
      if (this._localTile?.video) this._localTile.video.srcObject = this.localStream;

      // Hot-swap the track in all live peer connections (no renegotiation needed)
      this.peers.forEach(peer => {
        const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newTrack).catch(console.error);
      });

      this.currentQuality = quality;
      localStorage.setItem('gs-video-quality', quality);
      this._setStatus(`📐 ${VIDEO_QUALITIES[quality].label}`, '#86efac');
    } catch (err) {
      console.error('Quality change failed:', err);
      this._setStatus('⚠️ Quality change failed', '#fca5a5');
    }
  }

  // ── chat panel ────────────────────────────────────────────────────────────

  _buildChatPanel() {
    this._chat = mk('div', `
      position:fixed; bottom:80px; right:14px; width:288px; z-index:100;
      background:#1e293b; border:1px solid #334155; border-radius:12px;
      display:none; flex-direction:column; overflow:hidden;
      box-shadow:0 4px 24px #00000066;
    `);

    // Header
    const hdr = mk('div', `
      padding:9px 12px; background:#0f172a; border-bottom:1px solid #334155;
      display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
    `);
    const hdrTitle = mk('span', 'font-family:monospace;font-size:13px;color:#94a3b8;font-weight:bold;');
    hdrTitle.textContent = '💬 Nearby Chat';
    this._unreadBadge = mk('span', `
      background:#ef4444; color:#fff; font-size:10px;
      border-radius:10px; padding:1px 6px; display:none; font-family:monospace;
    `);
    this._unreadCount = 0;
    hdr.append(hdrTitle, this._unreadBadge);

    // Message list
    this._chatMessages = mk('div', `
      overflow-y:auto; padding:8px; display:flex; flex-direction:column;
      gap:5px; max-height:220px; min-height:80px;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);

    // Input row
    const inputRow = mk('div', `
      display:flex; gap:6px; padding:8px; border-top:1px solid #334155; flex-shrink:0;
    `);
    this._chatInput = document.createElement('input');
    this._chatInput.type = 'text';
    this._chatInput.placeholder = 'Say something…';
    this._chatInput.maxLength = 300;
    this._chatInput.style.cssText = `
      flex:1; background:#0f172a; color:#e2e8f0; border:1px solid #334155;
      border-radius:6px; padding:6px 8px; font-family:monospace; font-size:12px; outline:none;
    `;
    this._chatInput.addEventListener('focus', () => {
      this._chatInput.style.borderColor = '#3b82f6';
      this._unreadCount = 0;
      this._unreadBadge.style.display = 'none';
    });
    this._chatInput.addEventListener('blur', () => this._chatInput.style.borderColor = '#334155');
    this._chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage(this._chatInput.value);
        this._chatInput.value = '';
      }
    });

    const sendBtn = mk('button', `
      background:#2563eb; border:none; color:#fff; border-radius:6px;
      padding:6px 10px; font-family:monospace; font-size:12px; cursor:pointer;
    `);
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('mouseenter', () => sendBtn.style.background = '#1d4ed8');
    sendBtn.addEventListener('mouseleave', () => sendBtn.style.background = '#2563eb');
    sendBtn.addEventListener('click', () => {
      this._sendMessage(this._chatInput.value);
      this._chatInput.value = '';
      this._chatInput.focus();
    });

    inputRow.append(this._chatInput, sendBtn);
    this._chat.append(hdr, this._chatMessages, inputRow);
    document.body.appendChild(this._chat);
  }

  _showChat() {
    this._chat.style.display = 'flex';
  }

  _hideChat() {
    const anyOpen = Array.from(this.peers.values()).some(p => p.dc?.readyState === 'open');
    if (!anyOpen) this._chat.style.display = 'none';
  }

  _appendMessage(name, text, isSelf) {
    const row = mk('div', `
      display:flex; flex-direction:column; gap:2px;
      align-items:${isSelf ? 'flex-end' : 'flex-start'};
    `);
    const nameEl = mk('div', 'font-family:monospace;font-size:10px;color:#64748b;padding:0 4px;');
    nameEl.textContent = name;
    const bubble = mk('div', `
      background:${isSelf ? '#1d4ed8' : '#334155'};
      color:#e2e8f0; font-family:monospace; font-size:12px; line-height:1.4;
      padding:5px 10px;
      border-radius:${isSelf ? '10px 10px 2px 10px' : '10px 10px 10px 2px'};
      max-width:220px; word-break:break-word; white-space:pre-wrap;
    `);
    bubble.textContent = text;
    row.append(nameEl, bubble);
    this._chatMessages.appendChild(row);
    this._chatMessages.scrollTop = this._chatMessages.scrollHeight;

    // Show unread badge when chat input is not focused
    if (document.activeElement !== this._chatInput) {
      this._unreadCount++;
      this._unreadBadge.textContent = this._unreadCount;
      this._unreadBadge.style.display = 'inline';
    }
  }

  _sendMessage(text) {
    text = text.trim();
    if (!text) return;
    const payload = JSON.stringify({ name: this.localName, text });
    this.peers.forEach(peer => {
      if (peer.dc?.readyState === 'open') peer.dc.send(payload);
    });
    this._appendMessage(this.localName, text, true);
    this._unreadCount = 0;
    this._unreadBadge.style.display = 'none';
  }

  // ── media ─────────────────────────────────────────────────────────────────

  async _requestMedia() {
    const { w, h } = VIDEO_QUALITIES[this.currentQuality];
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: w }, height: { ideal: h }, facingMode: 'user' },
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
    // The socket with the lexicographically smaller ID always initiates,
    // preventing both sides from sending offers simultaneously.
    if ((this.socket.id ?? '') < peerId) this._initiatePeer(peerId);
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl?.remove();
    peer.filmTile?.wrapper.remove();
    this.peers.delete(peerId);
    this._hideChat();
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
    // Answerer side receives the data channel created by the initiator
    pc.ondatachannel = ({ channel }) => this._setupDataChannel(peerId, channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closePeer(peerId);
      }
    };
    return pc;
  }

  _initiatePeer(peerId) {
    const pc = this._makePeerConnection(peerId);
    this.peers.set(peerId, { pc, stream: null, audioEl: null, filmTile: null, dc: null });
    const dc = pc.createDataChannel('chat', { ordered: true });
    this._setupDataChannel(peerId, dc);
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
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = stream;
    document.body.appendChild(audioEl);
    peer.audioEl = audioEl;
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  _setupDataChannel(peerId, channel) {
    const peer = this.peers.get(peerId);
    if (peer) peer.dc = channel;
    channel.onopen = () => this._showChat();
    channel.onmessage = ({ data }) => {
      try {
        const { name, text } = JSON.parse(data);
        this._appendMessage(name, text, false);
        if (this._chat.style.display === 'none') this._showChat();
      } catch { /* malformed message, ignore */ }
    };
    channel.onclose = () => this._hideChat();
  }

  // ── signaling ─────────────────────────────────────────────────────────────

  async onOffer({ fromId, offer }) {
    if (this.peers.has(fromId) || !this.localStream) return;
    const pc = this._makePeerConnection(fromId);
    this.peers.set(fromId, { pc, stream: null, audioEl: null, filmTile: null, dc: null });
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
    this._chat?.remove();
    this._settingsEl?.remove();
  }
}

// Tiny helper — creates an element and sets its inline style in one call
function mk(tag, css = '') {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css.replace(/\s+/g, ' ').trim();
  return el;
}
