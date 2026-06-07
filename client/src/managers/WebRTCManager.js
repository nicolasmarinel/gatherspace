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

// bitrate caps (bps) keep bandwidth predictable while letting the encoder
// spend enough bits to avoid the heavy compression artifacts WebRTC's
// conservative defaults produce.
const VIDEO_QUALITIES = {
  sd:  { label: 'Standard  (640×480)',  w: 640,  h: 480,  bitrate:   700_000, fps: 30 },
  hd:  { label: 'HD  (1280×720)',       w: 1280, h: 720,  bitrate: 1_800_000, fps: 30 },
  fhd: { label: 'Full HD  (1920×1080)', w: 1920, h: 1080, bitrate: 3_500_000, fps: 30 },
};

const TILE_W = 256;
const TILE_H = 192;

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
    this.peers       = new Map();  // peerId -> { pc, stream, audioEl, filmTile, dc }
    this.screenPeers = new Map();  // peerId -> { pc, stream, filmTile }
    this.peerNames   = new Map();  // peerId -> string
    this.localStream  = null;

    this.audioMuted     = false;
    this.videoHidden    = false;
    this.selfViewHidden = false;
    this.screenSharing  = false;
    this._screenStream  = null;   // active getDisplayMedia stream
    this._expandedOpen  = false;
    this._focusedKey    = null;   // participant key pinned to the focus stage
    this._settingsEl    = null;
    this.currentQuality = localStorage.getItem('gs-video-quality') || 'sd';
    // 'enhanced' = full per-quality bitrate; 'reduced' = lighter for old hardware / weak links
    this.bitrateMode = localStorage.getItem('gs-bitrate-mode') || 'enhanced';
    this._canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

    // _mediaSettled flips true once the media request resolves (success OR failure).
    // Proximity won't initiate, and incoming offers won't be answered, until then —
    // so a slow camera no longer drops the very first handshake.
    this._mediaSettled = false;

    this._buildShell();
    this._mediaReadyPromise = this._requestMedia();
  }

  // ── DOM shell ─────────────────────────────────────────────────────────────

  _buildShell() {
    // Filmstrip — top-left
    this._filmstrip = mk('div', `
      position:fixed; top:14px; left:14px; z-index:100;
      display:flex; gap:8px; flex-wrap:wrap; max-width:70vw; align-items:flex-start;
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
    const barBtns = [
      this._ctrlBtn('🎤', 'Mute mic',       'mute', () => this._toggleMute()),
      this._ctrlBtn('📷', 'Hide camera',    'cam',  () => this._toggleCam()),
      this._ctrlBtn('👁️', 'Hide self-view', 'self', () => this._toggleSelf()),
    ];
    if (this._canScreenShare) {
      barBtns.push(
        mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
        this._ctrlBtn('🖥️', 'Share screen', 'screen', () => this._toggleScreenShare()),
      );
    }
    barBtns.push(
      mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
      this._ctrlBtn('⚙️', 'Settings', '', () => this._openSettings()),
    );
    this._bar.append(...barBtns);
    document.body.appendChild(this._bar);

    // Status badge — top-right
    this._status = mk('div', `
      position:fixed; top:14px; right:14px; z-index:100;
      background:#1e293b; border:1px solid #334155; border-radius:8px;
      font-family:monospace; font-size:12px; padding:6px 10px; color:#64748b;
    `);
    this._status.textContent = '🎤 Requesting media…';
    this._status.style.cursor = 'pointer';
    this._status.title = 'Click to re-request camera / microphone';
    this._status.addEventListener('click', () => this._retryMedia());
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
    // contain + black fill: always show the whole frame, never crop/reframe
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
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
      mute:   { active: this.audioMuted,     on: '🔇', off: '🎤', bg: '#7f1d1d' },
      cam:    { active: this.videoHidden,    on: '🚫', off: '📷', bg: '#7f1d1d' },
      self:   { active: this.selfViewHidden, on: '🙈', off: '👁️', bg: '#334155' },
      screen: { active: this.screenSharing,  on: '🛑', off: '🖥️', bg: '#14532d' },
    };
    const entry = map[btn.dataset.gsCtrl];
    if (!entry) return;
    btn.textContent = entry.active ? entry.on : entry.off;
    btn.style.background = entry.active ? entry.bg : 'none';
    btn.dataset.active = entry.active ? '1' : '';
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

  async _toggleScreenShare() {
    if (this.screenSharing) { this._stopScreenShare(); return; }
    try {
      // Browser's native picker — user chooses a window or full screen
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true,
      });
      this._screenStream = screenStream;
      this.screenSharing = true;

      // Add a local preview tile for the screen (camera tile stays untouched)
      this._localScreenTile = this._makeTile(screenStream, `${this.localName}'s screen`, false);
      this._localScreenTile.wrapper.style.borderColor = '#0ea5e9';
      this._filmstrip.appendChild(this._localScreenTile.wrapper);

      // Open a dedicated screen-share peer connection to every connected peer
      this.peers.forEach((_, peerId) => this._initiateScreenPeer(peerId));

      // When the user clicks the browser's "Stop sharing" button
      screenStream.getVideoTracks()[0].onended = () => this._stopScreenShare();

      this._syncControlBtns();
      this._setStatus('🖥️ Screen sharing', '#fde68a');
    } catch (err) {
      if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
        console.error('Screen share failed:', err);
        this._setStatus('⚠️ Screen share failed', '#fca5a5');
      }
    }
  }

  _stopScreenShare() {
    if (!this.screenSharing) return;
    this._screenStream?.getTracks().forEach(t => t.stop());
    this._screenStream = null;
    this.screenSharing = false;

    // Close all screen-share peer connections and remove their tiles
    this.screenPeers.forEach((_, id) => this._removeScreenPeer(id));

    // Remove local screen preview tile
    this._localScreenTile?.wrapper.remove();
    this._localScreenTile = null;

    this._syncControlBtns();
    if (this._expandedOpen) this._buildExpandedGrid();
    this._setStatus('🟢 Camera + mic ready', '#86efac');
  }

  // ── screen-share peer connections ─────────────────────────────────────────

  _makeScreenPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.sendScreenIce(peerId, candidate);
    };
    pc.ontrack = ({ streams }) => this._attachScreenStream(peerId, streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._removeScreenPeer(peerId);
      }
    };
    return pc;
  }

  _initiateScreenPeer(peerId) {
    if (this.screenPeers.has(peerId) || !this._screenStream) return;
    const pc = this._makeScreenPeerConnection(peerId);
    this.screenPeers.set(peerId, { pc, stream: null, filmTile: null });
    this._screenStream.getTracks().forEach(t => pc.addTrack(t, this._screenStream));
    pc.createOffer()
      .then(o => pc.setLocalDescription(o).then(() => o))
      .then(o => this.socket.sendScreenOffer(peerId, o))
      .catch(console.error);
  }

  _attachScreenStream(peerId, stream) {
    const peer = this.screenPeers.get(peerId);
    if (!peer || peer.stream) return;
    peer.stream = stream;
    const name = this.peerNames.get(peerId) || 'Player';
    const tile = this._makeTile(stream, `${name}'s screen`, false);
    tile.wrapper.style.borderColor = '#0ea5e9'; // sky-blue border marks screen tiles
    peer.filmTile = tile;
    this._filmstrip.appendChild(tile.wrapper);
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  _removeScreenPeer(peerId) {
    const peer = this.screenPeers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.filmTile?.wrapper.remove();
    this.screenPeers.delete(peerId);
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  async onScreenOffer({ fromId, offer }) {
    if (this.screenPeers.has(fromId)) return;
    const pc = this._makeScreenPeerConnection(fromId);
    this.screenPeers.set(fromId, { pc, stream: null, filmTile: null });
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.sendScreenAnswer(fromId, answer);
  }

  async onScreenAnswer({ fromId, answer }) {
    await this.screenPeers.get(fromId)?.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async onScreenIce({ fromId, candidate }) {
    try {
      await this.screenPeers.get(fromId)?.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch { /* benign */ }
  }

  // ── expanded overlay ──────────────────────────────────────────────────────

  _openExpanded() {
    this._expandedOpen = true;
    this._overlay.style.display = 'flex';
    this._buildExpandedGrid();
  }

  _closeExpanded() {
    this._expandedOpen = false;
    this._focusedKey = null;
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
    // Recreate toggles inside the overlay — _syncControlBtns() keeps them in sync
    const hdrBtns = [
      this._ctrlBtn('🎤', 'Mute mic',       'mute', () => this._toggleMute()),
      this._ctrlBtn('📷', 'Hide camera',    'cam',  () => this._toggleCam()),
      this._ctrlBtn('👁️', 'Hide self-view', 'self', () => this._toggleSelf()),
    ];
    if (this._canScreenShare) {
      hdrBtns.push(
        mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
        this._ctrlBtn('🖥️', 'Share screen', 'screen', () => this._toggleScreenShare()),
      );
    }
    hdrBtns.push(
      mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
      this._ctrlBtn('⚙️', 'Settings', '', () => this._openSettings()),
    );
    header.append(...hdrBtns);
    const spacer = mk('div', 'flex:1;');
    const closeBtn = mk('button', `
      background:#334155; border:none; color:#e2e8f0; font-size:18px;
      width:36px; height:36px; border-radius:50%; cursor:pointer;
    `);
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this._closeExpanded());
    header.append(spacer, closeBtn);

    // ── Participants (each gets a stable key for focus tracking) ──
    const participants = [];
    if (!this.selfViewHidden && this.localStream) {
      participants.push({ key: 'local-cam', stream: this.localStream, name: `${this.localName} (you)`, screen: false });
    }
    if (this.screenSharing && this._screenStream) {
      participants.push({ key: 'local-screen', stream: this._screenStream, name: `${this.localName}'s screen`, screen: true });
    }
    this.peers.forEach((peer, id) => {
      if (peer.stream) {
        participants.push({ key: `cam:${id}`, stream: peer.stream, name: this.peerNames.get(id) || 'Player', screen: false });
      }
    });
    this.screenPeers.forEach((peer, id) => {
      if (peer.stream) {
        participants.push({ key: `screen:${id}`, stream: peer.stream, name: `${this.peerNames.get(id) || 'Player'}'s screen`, screen: true });
      }
    });

    // Drop a stale focus if that participant has left
    if (this._focusedKey && !participants.some(p => p.key === this._focusedKey)) {
      this._focusedKey = null;
    }

    let body;
    if (participants.length === 0) {
      body = mk('div', `
        flex:1; display:flex; align-items:center; justify-content:center;
        font-family:monospace; color:#64748b; font-size:15px;
      `);
      body.textContent = 'No one nearby — walk up to someone!';
    } else if (this._focusedKey) {
      body = this._buildFocusView(participants);
    } else {
      body = this._buildGridView(participants);
    }

    this._overlay.append(header, body);
  }

  // A video element that always shows the whole frame, black-filling the rest
  _makeExpVideo(stream) {
    const vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    vid.srcObject = stream;
    vid.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    return vid;
  }

  _cellLabel(name, small = false) {
    const lbl = mk('div', `
      position:absolute; bottom:0; left:0; right:0;
      background:#000000bb; font-family:monospace;
      font-size:${small ? '10px' : '13px'}; color:#e2e8f0;
      padding:${small ? '3px 6px' : '6px 10px'};
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    `);
    lbl.textContent = name;
    return lbl;
  }

  // Equal-sized grid; clicking any cell focuses that participant
  _buildGridView(participants) {
    const cols = gridCols(participants.length);
    const grid = mk('div', `
      flex:1; overflow-y:auto; padding:14px;
      display:grid; grid-template-columns:repeat(${cols},1fr);
      gap:10px; align-content:start;
    `);
    participants.forEach(p => {
      const cell = mk('div', `
        position:relative; border-radius:12px; overflow:hidden; cursor:pointer;
        background:#000; border:2px solid ${p.screen ? '#0ea5e9' : '#334155'}; aspect-ratio:16/9;
      `);
      cell.append(this._makeExpVideo(p.stream), this._cellLabel(p.name));
      cell.addEventListener('click', () => { this._focusedKey = p.key; this._buildExpandedGrid(); });
      grid.appendChild(cell);
    });
    return grid;
  }

  // One participant fills the stage; everyone else sits in a strip below.
  // This focus state is local to this client only.
  _buildFocusView(participants) {
    const focused = participants.find(p => p.key === this._focusedKey);
    const wrap = mk('div', 'flex:1; display:flex; flex-direction:column; min-height:0; padding:14px; gap:10px;');

    // Main stage — click to de-focus back to the grid
    const stage = mk('div', `
      position:relative; flex:1; min-height:0; border-radius:12px; overflow:hidden;
      cursor:pointer; background:#000;
      border:2px solid ${focused.screen ? '#0ea5e9' : '#3b82f6'};
    `);
    stage.append(this._makeExpVideo(focused.stream), this._cellLabel(focused.name));
    const hint = mk('div', `
      position:absolute; top:10px; right:12px; background:#000000aa;
      font-family:monospace; font-size:11px; color:#cbd5e1;
      padding:4px 8px; border-radius:6px;
    `);
    hint.textContent = 'click to exit focus';
    stage.appendChild(hint);
    stage.addEventListener('click', () => { this._focusedKey = null; this._buildExpandedGrid(); });

    // Strip of every participant; click to switch focus (or unfocus the active one)
    const strip = mk('div', `
      display:flex; gap:8px; overflow-x:auto; flex-shrink:0; padding-bottom:4px;
      justify-content:center;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);
    participants.forEach(p => {
      const isFocused = p.key === this._focusedKey;
      const thumb = mk('div', `
        position:relative; border-radius:8px; overflow:hidden; cursor:pointer; flex-shrink:0;
        width:320px; height:180px; background:#000;
        border:2px solid ${isFocused ? '#3b82f6' : (p.screen ? '#0ea5e9' : '#334155')};
        opacity:${isFocused ? '1' : '0.8'};
      `);
      thumb.append(this._makeExpVideo(p.stream), this._cellLabel(p.name, true));
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        this._focusedKey = isFocused ? null : p.key;
        this._buildExpandedGrid();
      });
      strip.appendChild(thumb);
    });

    wrap.append(stage, strip);
    return wrap;
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

    // Bandwidth section
    const bwLabel = mk('div', 'font-size:11px;color:#64748b;letter-spacing:.05em;margin:22px 0 10px;');
    bwLabel.textContent = 'BANDWIDTH';

    const BW_OPTIONS = [
      { key: 'enhanced', label: 'Enhanced  (sharper)' },
      { key: 'reduced',  label: 'Reduced  (old hardware / slow link)' },
    ];
    const bwOptions = mk('div', 'display:flex;flex-direction:column;gap:6px;');
    BW_OPTIONS.forEach(({ key, label }) => {
      const isActive = key === this.bitrateMode;
      const row = mk('label', `
        display:flex; align-items:center; gap:10px; padding:10px 12px;
        border-radius:8px; cursor:pointer;
        border:1px solid ${isActive ? '#3b82f6' : '#334155'};
        background:${isActive ? '#1e3a5f' : 'transparent'};
        transition:all .15s;
      `);
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gs-bitrate';
      radio.value = key;
      radio.checked = isActive;
      radio.style.accentColor = '#3b82f6';
      radio.addEventListener('change', () => {
        if (radio.checked) { this._changeBitrateMode(key); this._closeSettings(); }
      });
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.fontSize = '14px';
      row.append(radio, lbl);
      bwOptions.appendChild(row);
    });

    const bwNote = mk('div', 'font-size:11px;color:#475569;margin-top:14px;line-height:1.5;');
    bwNote.textContent = 'Reduced lowers the bitrate and frame rate to ease strain on older machines and weak connections.';

    panel.append(titleRow, sectionLabel, options, note, bwLabel, bwOptions, bwNote);
    modal.appendChild(panel);
    document.body.appendChild(modal);
    this._settingsEl = modal;
  }

  _changeBitrateMode(mode) {
    if (mode === this.bitrateMode) return;
    this.bitrateMode = mode;
    localStorage.setItem('gs-bitrate-mode', mode);
    // Re-apply caps to every live connection immediately (no renegotiation)
    this.peers.forEach(peer => this._tuneVideoBitrate(peer.pc));
    this._setStatus(
      mode === 'reduced' ? '📉 Reduced bandwidth mode' : '📈 Enhanced quality mode',
      '#86efac'
    );
  }

  _closeSettings() {
    this._settingsEl?.remove();
    this._settingsEl = null;
  }

  async _changeQuality(quality) {
    if (quality === this.currentQuality) return;
    const { w, h, fps } = VIDEO_QUALITIES[quality];
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
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

      this.currentQuality = quality;
      localStorage.setItem('gs-video-quality', quality);

      // Hot-swap the track in all live peer connections (no renegotiation needed),
      // then re-apply the new quality's bitrate ceiling.
      this.peers.forEach(peer => {
        const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newTrack).catch(console.error);
        this._tuneVideoBitrate(peer.pc);
      });

      this._setStatus(`📐 ${VIDEO_QUALITIES[quality].label}`, '#86efac');
    } catch (err) {
      console.error('Quality change failed:', err);
      this._setStatus('⚠️ Quality change failed', '#fca5a5');
    }
  }

  // ── chat panel ────────────────────────────────────────────────────────────

  _buildChatPanel() {
    // Docked full-height panel on the right edge of the screen
    this._chat = mk('div', `
      position:fixed; top:0; right:0; bottom:0; width:300px; z-index:100;
      background:#1e293b; border-left:1px solid #334155;
      display:none; flex-direction:column; overflow:hidden;
      box-shadow:-4px 0 24px #00000066;
    `);

    // Header
    const hdr = mk('div', `
      padding:11px 14px; background:#0f172a; border-bottom:1px solid #334155;
      display:flex; align-items:center; gap:8px; flex-shrink:0;
    `);
    const hdrTitle = mk('span', 'font-family:monospace;font-size:13px;color:#94a3b8;font-weight:bold;flex:1;');
    hdrTitle.textContent = '💬 Nearby Chat';
    this._unreadBadge = mk('span', `
      background:#ef4444; color:#fff; font-size:10px;
      border-radius:10px; padding:1px 6px; display:none; font-family:monospace;
    `);
    this._unreadCount = 0;

    // Minimize / restore toggle — collapses the panel to just this header bar
    this._chatMinimized = false;
    this._chatMinBtn = mk('button', `
      background:#334155; border:none; color:#e2e8f0; font-size:16px;
      width:26px; height:26px; border-radius:6px; cursor:pointer; line-height:1;
      flex-shrink:0;
    `);
    this._chatMinBtn.textContent = '–';
    this._chatMinBtn.title = 'Minimize chat';
    this._chatMinBtn.addEventListener('click', () => this._toggleChatMinimize());

    hdr.append(hdrTitle, this._unreadBadge, this._chatMinBtn);

    // Message list — grows to fill the panel
    this._chatMessages = mk('div', `
      flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column;
      gap:5px;
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
      } else if (e.key === 'Escape') {
        // Release focus so arrow-key movement resumes
        this._chatInput.blur();
      }
      // Don't let keystrokes reach Phaser's keyboard handler while typing
      e.stopPropagation();
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
    this._chatInputRow = inputRow;
    this._chat.append(hdr, this._chatMessages, inputRow);
    document.body.appendChild(this._chat);
  }

  // Collapse the chat to just its header bar (frees the screen, esp. on mobile)
  _toggleChatMinimize() {
    this._chatMinimized = !this._chatMinimized;
    const hide = this._chatMinimized;
    this._chatMessages.style.display = hide ? 'none' : 'flex';
    this._chatInputRow.style.display = hide ? 'none' : 'flex';
    // bottom:auto lets the panel shrink to header height when collapsed
    this._chat.style.bottom = hide ? 'auto' : '0';
    this._chatMinBtn.textContent = hide ? '+' : '–';
    this._chatMinBtn.title = hide ? 'Expand chat' : 'Minimize chat';
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
    this._mediaSettled = false;

    // getUserMedia is only available on a secure origin (https / localhost)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this._setStatus('🔒 Camera needs HTTPS — tap to retry', '#fca5a5');
      this._mediaSettled = true;
      return;
    }

    // Surface Chrome's stored permission decision. A 'denied' state means the
    // site was blocked and getUserMedia will never prompt — the user must
    // re-allow it via the address-bar icon.
    try {
      const cam = await navigator.permissions?.query({ name: 'camera' });
      if (cam?.state === 'denied') {
        this._setStatus('🚫 Camera blocked — click 🔒/🎥 in address bar → Allow, then tap here', '#fca5a5');
      }
    } catch { /* Permissions API may not support 'camera' — ignore */ }

    // Wrap getUserMedia with a timeout so a missing device or a suppressed
    // permission prompt doesn't hang the UI forever. 20s leaves room for a
    // user to actually click "Allow" on the prompt.
    const timed = (p) => Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 20000)
      ),
    ]);

    const { w, h, fps } = VIDEO_QUALITIES[this.currentQuality];
    try {
      this.localStream = await timed(navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }));
      this._showLocalStream();
    } catch (err) {
      if (err.name === 'TimeoutError') {
        this._setStatus('⚠️ No permission prompt — click 🔒/🎥 in address bar → Allow, then tap here', '#fca5a5');
      } else {
        // Camera failed (busy, blocked, or absent) — fall back to audio-only
        try {
          this.localStream = await timed(navigator.mediaDevices.getUserMedia({ audio: true }));
          this._showLocalStream();
          this._setStatus('🎤 Audio only — tap to retry camera', '#fde68a');
        } catch (err2) {
          this._setStatus(
            err2.name === 'TimeoutError'
              ? '⚠️ No device found — tap to retry'
              : '❌ Media blocked — tap to retry',
            '#fca5a5'
          );
        }
      }
    } finally {
      // Unblock proximity/offer handling whether media succeeded or not,
      // so a camera-less machine can still receive others' video & audio.
      this._mediaSettled = true;
    }
  }

  // Wires a freshly acquired localStream into the local tile and reports
  // real track state — this surfaces "camera held by another app" cases
  // where the stream resolves but no frames ever flow (LED stays off).
  _showLocalStream() {
    if (!this.localStream) return;
    const v = this._localTile.video;
    v.srcObject = this.localStream;
    v.play?.().catch(() => { /* autoplay edge cases — harmless */ });

    const vt = this.localStream.getVideoTracks()[0];
    if (vt) {
      // track.muted === true means the OS handed us the device but no frames
      // are flowing (typically another app is holding the camera).
      if (vt.muted) {
        this._setStatus('📷 Camera busy (another app?) — tap retry', '#fde68a');
      } else {
        this._setStatus('🟢 Camera + mic ready', '#86efac');
      }
      vt.onmute   = () => this._setStatus('📷 Camera lost frames — tap retry', '#fde68a');
      vt.onunmute = () => this._setStatus('🟢 Camera + mic ready', '#86efac');
      vt.onended  = () => this._setStatus('📷 Camera disconnected — tap retry', '#fca5a5');
    } else {
      this._setStatus('🎤 Audio only — tap to retry camera', '#fde68a');
    }
  }

  // Re-acquire media on demand (status badge click) without a page reload,
  // then push the new tracks into any already-connected peers.
  async _retryMedia() {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this._setStatus('🎤 Requesting media…', '#64748b');

    this._mediaReadyPromise = this._requestMedia();
    await this._mediaReadyPromise;
    if (!this.localStream) return;

    // Hot-swap new tracks into existing senders (no renegotiation needed)
    this.peers.forEach(peer => {
      this.localStream.getTracks().forEach(track => {
        const sender = peer.pc.getSenders().find(s => s.track?.kind === track.kind);
        if (sender) sender.replaceTrack(track).catch(() => {});
      });
      this._tuneVideoBitrate(peer.pc);
    });
  }

  _setStatus(text, color) {
    this._status.textContent = text;
    this._status.style.color = color;
  }

  // ── proximity (called by GameScene) ───────────────────────────────────────

  onNearby(peerId, name) {
    if (name) this.peerNames.set(peerId, name);
    // Gate on _mediaSettled (not localStream) so a camera-less client still
    // connects — it'll negotiate a receive-only peer.
    if (!this.peers.has(peerId) && this._mediaSettled) {
      // Smaller socket ID always initiates to avoid double-offers
      if ((this.socket.id ?? '') < peerId) this._initiatePeer(peerId);
    }
    // If we're already sharing a screen, open a screen peer for this newcomer too
    if (this.screenSharing && !this.screenPeers.has(peerId)) {
      this._initiateScreenPeer(peerId);
    }
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl?.remove();
    peer.filmTile?.wrapper.remove();
    this.peers.delete(peerId);
    this._removeScreenPeer(peerId); // close screen peer if one exists
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

  // Raise the encoder's bitrate ceiling so video isn't over-compressed.
  // WebRTC defaults are conservative; this lets the chosen quality look sharp
  // while still capping bandwidth at a predictable value.
  async _tuneVideoBitrate(pc) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const q = VIDEO_QUALITIES[this.currentQuality];
    const reduced = this.bitrateMode === 'reduced';
    // Reduced mode caps bitrate ~40% and framerate at 20fps to ease CPU/bandwidth
    params.encodings[0].maxBitrate   = reduced ? Math.round(q.bitrate * 0.4) : q.bitrate;
    params.encodings[0].maxFramerate = reduced ? 20 : q.fps;
    // Prefer dropping frames over shrinking resolution under bandwidth pressure
    params.degradationPreference = 'maintain-resolution';
    try { await sender.setParameters(params); }
    catch (e) { console.warn('Bitrate tuning failed:', e); }
  }

  _initiatePeer(peerId) {
    const pc = this._makePeerConnection(peerId);
    this.peers.set(peerId, { pc, stream: null, audioEl: null, filmTile: null, dc: null });
    const dc = pc.createDataChannel('chat', { ordered: true });
    this._setupDataChannel(peerId, dc);
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
      this._tuneVideoBitrate(pc);
    } else {
      // No camera/mic — still negotiate so we can receive the other side
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
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
    if (this.peers.has(fromId)) return;
    // Wait for media to settle instead of dropping the offer — this is the fix
    // for connections failing on first login until players walk apart & back.
    await this._mediaReadyPromise;
    if (this.peers.has(fromId)) return; // a duplicate offer may have raced us

    const pc = this._makePeerConnection(fromId);
    this.peers.set(fromId, { pc, stream: null, audioEl: null, filmTile: null, dc: null });
    // If we have no local media, the remote's send-only tracks still create
    // receive-only transceivers here automatically — so we receive them.
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
      this._tuneVideoBitrate(pc);
    }
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

  // ── reconnect ─────────────────────────────────────────────────────────────

  // Called by GameScene when the socket reconnects with a new ID.
  // Closes all peer connections; they'll re-establish via proximity detection.
  onSocketReconnect() {
    Array.from(this.peers.keys()).forEach(id => this.closePeer(id));
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this.peers.forEach((_, id) => this.closePeer(id));
    this._stopScreenShare();
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
