// Manages proximity-based WebRTC peer connections.
// Chat uses RTCDataChannel — peer-to-peer, automatically scoped to nearby players.
// STUN handles most networks; Open Relay TURN covers strict-NAT home routers.

import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

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

export class WebRTCManager {
  constructor(socketManager, localName = 'You', profile = {}) {
    this.socket     = socketManager;
    this.localName  = localName;
    this.localProfile = { name: localName, email: profile.email || null, picture: profile.picture || null };
    this.onEditMap = null;       // set by the scene to toggle the map editor
    this.onToggleZoneLock = null; // set by the scene to lock/unlock the current zone
    // Presence + direct messages
    this._presence = [];                  // [{ email, name, picture, online }]
    this._dmThreads = new Map();          // peerEmail -> [{ from, text, ts }]
    this._dmUnread = new Map();           // peerEmail -> count
    this._activeDM = null;                // peerEmail of the open thread
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

    // RNNoise ML noise suppression (kills keyboard/traffic/hum). On by default.
    this.noiseSuppression = localStorage.getItem('gs-noise') !== 'off';
    this._rawAudioTrack = null;    // mic track straight from getUserMedia
    this._cleanAudioTrack = null;  // denoised output track
    this._audioCtx = null;
    this._denoiseNode = null;

    // Self-view mirror (local display only) + chosen input devices
    this.mirrorSelf = localStorage.getItem('gs-mirror') === 'on';
    this.videoDeviceId = localStorage.getItem('gs-cam') || null;
    this.audioDeviceId = localStorage.getItem('gs-mic') || null;

    // Output audio: a Web Audio graph per peer enables a loudness maximizer
    // (compressor + makeup gain) and per-user volume (can exceed 1.0).
    this.maximizer = localStorage.getItem('gs-maximizer') === 'on';
    this._outCtx = null;

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

    // Full-width control bar across the bottom of the screen
    this._bar = mk('div', `
      position:fixed; left:0; right:0; bottom:0; z-index:130;
      display:flex; align-items:center; gap:8px; padding:8px 14px;
      background:#1e293b; border-top:1px solid #334155; font-family:monospace;
    `);
    const sep = () => mk('div', 'width:1px;height:24px;background:#334155;margin:0 4px;');

    // Left: avatar + display name
    const avatar = document.createElement('img');
    avatar.referrerPolicy = 'no-referrer';
    if (this.localProfile.picture) avatar.src = this.localProfile.picture;
    avatar.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#334155;flex-shrink:0;object-fit:cover;';
    const nameEl = mk('div', `
      font-size:13px; color:#e2e8f0; font-weight:bold; white-space:nowrap;
      max-width:180px; overflow:hidden; text-overflow:ellipsis;
    `);
    nameEl.textContent = this.localName;

    const left = [avatar, nameEl, sep(),
      this._ctrlBtn('mic',        'Mute mic',       'mute', () => this._toggleMute()),
      this._ctrlBtn('videocam',   'Hide camera',    'cam',  () => this._toggleCam()),
      this._ctrlBtn('visibility', 'Hide self-view', 'self', () => this._toggleSelf()),
    ];
    if (this._canScreenShare) left.push(this._ctrlBtn('screen_share', 'Share screen', 'screen', () => this._toggleScreenShare()));
    left.push(this._ctrlBtn('settings', 'Settings', '', () => this._openSettings()));

    const spacer = mk('div', 'flex:1;');

    // Right (right-aligned): hammer then messages, so messages is right-most
    this._editBarBtn = this._ctrlBtn('hardware', 'Edit map', '', () => this.onEditMap?.());
    this._dmBarBtn = this._ctrlBtn('chat_bubble', 'Messages', '', () => this._openMessages());

    this._bar.append(...left, spacer, this._editBarBtn, this._dmBarBtn);
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

    // Recompute the grid layout when the call view resizes (drag, tiling, etc.)
    // — updates CSS only, never rebuilds the <video>s, so there's no flicker.
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (this._expandedOpen && this._gridEl) this._applyGridLayout();
      }).observe(this._overlay);
    }

    // Esc closes the call view. (Chat's own Esc stops propagation, so typing
    // Esc in chat just blurs the field and won't reach this.)
    this._onEscKey = (e) => { if (e.key === 'Escape' && this._expandedOpen) this._closeExpanded(); };
    document.addEventListener('keydown', this._onEscKey);

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
  // iconName is a Material Symbols ligature (e.g. 'mic', 'settings').
  _ctrlBtn(iconName, title, ctrlKey, onClick) {
    const btn = mk('button', `
      background:none; border:none; cursor:pointer; padding:6px 8px; border-radius:8px;
      line-height:0; transition:background .15s; display:inline-flex; align-items:center;
    `);
    btn.title = title;
    const ic = mk('span', 'font-size:24px; color:#94a3b8;'); // lighter shade of the bar bg
    ic.className = 'material-symbols-outlined';
    ic.textContent = iconName;
    btn._iconEl = ic;
    btn.appendChild(ic);
    if (ctrlKey) btn.dataset.gsCtrl = ctrlKey;
    btn.addEventListener('mouseenter', () => { if (!btn.dataset.active) btn.style.background = '#334155'; });
    btn.addEventListener('mouseleave', () => { if (!btn.dataset.active) btn.style.background = 'none'; });
    btn.addEventListener('click', onClick);
    this._applyCtrlState(btn); // reflect current state immediately
    return btn;
  }

  _applyCtrlState(btn) {
    const map = {
      mute:   { active: this.audioMuted,     on: 'mic_off',           off: 'mic',          bg: '#7f1d1d' },
      cam:    { active: this.videoHidden,    on: 'videocam_off',      off: 'videocam',     bg: '#7f1d1d' },
      self:   { active: this.selfViewHidden, on: 'visibility_off',    off: 'visibility',   bg: '#334155' },
      screen: { active: this.screenSharing,  on: 'stop_screen_share', off: 'screen_share', bg: '#14532d' },
    };
    const entry = map[btn.dataset.gsCtrl];
    if (!entry) return;
    if (btn._iconEl) btn._iconEl.textContent = entry.active ? entry.on : entry.off;
    btn.style.background = entry.active ? entry.bg : 'none';
    btn.dataset.active = entry.active ? '1' : '';
  }

  // Refresh every control button anywhere in the document
  _syncControlBtns() {
    document.querySelectorAll('[data-gs-ctrl]').forEach(b => this._applyCtrlState(b));
  }

  // ── toggle actions ────────────────────────────────────────────────────────

  // Mic toggle actually releases / re-opens the microphone device.
  async _toggleMute() {
    if (this._togglingMic) return;
    this._togglingMic = true;
    try {
      if (!this.audioMuted) {
        this.audioMuted = true;
        this._rawAudioTrack?.stop();
        this._denoiseNode?.destroy?.();
        this._audioCtx?.close?.();
        this._audioCtx = null; this._denoiseNode = null; this._cleanAudioTrack = null;
        const cur = this.localStream?.getAudioTracks()[0];
        if (cur) this.localStream.removeTrack(cur);
        this._rawAudioTrack = null;
        this.peers.forEach(p => { const s = this._aSender(p); if (s) s.replaceTrack(null).catch(() => {}); });
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            ...(this.audioDeviceId ? { deviceId: { exact: this.audioDeviceId } } : {}),
          },
        });
        this._rawAudioTrack = stream.getAudioTracks()[0];
        this.audioMuted = false;
        if (this.noiseSuppression) { try { await this._ensureDenoiser(); } catch (e) { console.warn(e); } }
        this._applyAudioTrack();
      }
    } catch (e) {
      console.error('Mic toggle failed:', e);
      this._setStatus('⚠️ Mic toggle failed', '#fca5a5');
    } finally {
      this._togglingMic = false;
    }
    this._afterAvToggle();
  }

  // Camera toggle actually releases / re-opens the camera device (LED off).
  async _toggleCam() {
    if (this._togglingCam) return;
    this._togglingCam = true;
    try {
      if (!this.videoHidden) {
        this.videoHidden = true;
        const v = this.localStream?.getVideoTracks()[0];
        if (v) { this.localStream.removeTrack(v); v.stop(); }
        if (this._localTile?.video) this._localTile.video.srcObject = this.localStream;
        this.peers.forEach(p => { const s = this._vSender(p); if (s) s.replaceTrack(null).catch(() => {}); });
      } else {
        const { w, h, fps } = VIDEO_QUALITIES[this.currentQuality];
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps },
            ...(this.videoDeviceId ? { deviceId: { exact: this.videoDeviceId } } : { facingMode: 'user' }),
          },
        });
        const track = stream.getVideoTracks()[0];
        if (!this.localStream) { this.localStream = stream; }
        else {
          const old = this.localStream.getVideoTracks()[0];
          if (old) { this.localStream.removeTrack(old); old.stop(); }
          this.localStream.addTrack(track);
        }
        if (this._localTile?.video) {
          this._localTile.video.srcObject = this.localStream;
          this._localTile.video.style.transform = this.mirrorSelf ? 'scaleX(-1)' : '';
        }
        this.peers.forEach(p => {
          const s = this._vSender(p);
          if (s) s.replaceTrack(track).catch(() => {});
          this._tuneVideoBitrate(p.pc);
        });
        this.videoHidden = false;
      }
    } catch (e) {
      console.error('Camera toggle failed:', e);
      this._setStatus('⚠️ Camera toggle failed', '#fca5a5');
    } finally {
      this._togglingCam = false;
    }
    this._afterAvToggle();
  }

  // Shared post-toggle: refresh buttons + local badges, tell peers, redraw call
  _afterAvToggle() {
    this._syncControlBtns();
    this._refreshLocalBadges();
    this._sendAvState();
    if (this._expandedOpen) this._buildExpandedGrid();
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
    // Hide the avatar-view previews and control bar so they don't sit behind
    // (and show through / overlap) the call view.
    this._filmstrip.style.display = 'none';
    this._bar.style.display = 'none';
    this._overlay.style.display = 'flex';
    this._buildExpandedGrid();
  }

  _closeExpanded() {
    this._expandedOpen = false;
    this._focusedKey = null;
    this._overlay.innerHTML = '';
    this._overlay.style.display = 'none';
    this._filmstrip.style.display = 'flex';
    this._bar.style.display = 'flex';
  }

  _buildExpandedGrid() {
    this._overlay.innerHTML = '';
    this._gridEl = null; // only set while the equal-grid view is mounted

    // ── Header: controls + close ──
    const header = mk('div', `
      display:flex; align-items:center; gap:6px; padding:10px 16px;
      background:#1e293bdd; border-bottom:1px solid #334155; flex-shrink:0;
    `);
    // Recreate toggles inside the overlay — _syncControlBtns() keeps them in sync
    const hdrBtns = [
      this._ctrlBtn('mic',        'Mute mic',       'mute', () => this._toggleMute()),
      this._ctrlBtn('videocam',   'Hide camera',    'cam',  () => this._toggleCam()),
      this._ctrlBtn('visibility', 'Hide self-view', 'self', () => this._toggleSelf()),
    ];
    if (this._canScreenShare) {
      hdrBtns.push(
        mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
        this._ctrlBtn('screen_share', 'Share screen', 'screen', () => this._toggleScreenShare()),
      );
    }
    hdrBtns.push(
      mk('div', 'width:1px;height:22px;background:#334155;margin:0 2px;'),
      this._ctrlBtn('settings', 'Settings', '', () => this._openSettings()),
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
      participants.push({ key: 'local-cam', stream: this.localStream, name: `${this.localName} (you)`, screen: false,
        audioMuted: this.audioMuted, videoHidden: this.videoHidden });
    }
    if (this.screenSharing && this._screenStream) {
      participants.push({ key: 'local-screen', stream: this._screenStream, name: `${this.localName}'s screen`, screen: true });
    }
    this.peers.forEach((peer, id) => {
      if (peer.stream) {
        participants.push({ key: `cam:${id}`, stream: peer.stream, name: this.peerNames.get(id) || 'Player', screen: false, peerId: id,
          audioMuted: peer.remoteAudioMuted, videoHidden: peer.remoteVideoHidden });
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

  // Mirror only the local camera's own preview (display-only, never the
  // stream sent to others).
  _maybeMirror(vid, key) {
    if (key === 'local-cam' && this.mirrorSelf) vid.style.transform = 'scaleX(-1)';
  }

  // ── mute / camera-off indicators ────────────────────────────────────────────

  // Adds/updates a camera-off cover and a mic-muted badge on a tile/cell.
  _applyAvBadges(wrapper, { audioMuted, videoHidden, name }, big = false) {
    let cover = wrapper.querySelector('[data-av-cover]');
    if (!cover) {
      cover = mk('div', `
        position:absolute; inset:0; z-index:3; display:none;
        align-items:center; justify-content:center; flex-direction:column; gap:6px;
        background:#0f172a; color:#94a3b8; font-family:monospace; text-align:center;
      `);
      cover.dataset.avCover = '1';
      const ic = mk('div', ''); ic.dataset.avCoverIcon = '1'; ic.textContent = '📷🚫';
      const nm = mk('div', 'color:#e2e8f0;'); nm.dataset.avCoverName = '1';
      cover.append(ic, nm);
      wrapper.appendChild(cover);
    }
    cover.style.display = videoHidden ? 'flex' : 'none';
    cover.querySelector('[data-av-cover-icon]').style.fontSize = big ? '40px' : '20px';
    const nmEl = cover.querySelector('[data-av-cover-name]');
    nmEl.textContent = name || '';
    nmEl.style.fontSize = big ? '15px' : '10px';

    let badge = wrapper.querySelector('[data-av-mic]');
    if (!badge) {
      badge = mk('div', `
        position:absolute; top:6px; left:6px; z-index:4; display:none;
        background:#7f1d1dcc; border-radius:6px; padding:2px 5px; line-height:1;
      `);
      badge.dataset.avMic = '1'; badge.textContent = '🔇';
      wrapper.appendChild(badge);
    }
    badge.style.fontSize = big ? '18px' : '12px';
    badge.style.display = audioMuted ? 'block' : 'none';
  }

  _refreshLocalBadges() {
    if (this._localTile?.wrapper) {
      this._applyAvBadges(this._localTile.wrapper, {
        audioMuted: this.audioMuted, videoHidden: this.videoHidden, name: this.localName,
      });
    }
  }

  _refreshPeerBadges(peer) {
    if (!peer?.filmTile?.wrapper) return;
    this._applyAvBadges(peer.filmTile.wrapper, {
      audioMuted: peer.remoteAudioMuted, videoHidden: peer.remoteVideoHidden,
      name: this.peerNames.get(peer.id) || 'Player',
    });
  }

  // Broadcast my mic/camera state to all connected peers (over the data channel)
  _sendAvState() {
    const payload = JSON.stringify({ t: 'av', audioMuted: this.audioMuted, videoHidden: this.videoHidden });
    this.peers.forEach(p => { if (p.dc?.readyState === 'open') p.dc.send(payload); });
  }

  _sendAvStateTo(peer) {
    if (peer?.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify({ t: 'av', audioMuted: this.audioMuted, videoHidden: this.videoHidden }));
    }
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

  // Per-user volume slider for a remote participant (0–200%). Pinned top-right
  // of a cell. Clicks are swallowed so they don't trigger focus toggling.
  _volumeSlider(peerId) {
    const wrap = mk('div', `
      position:absolute; top:8px; right:8px; z-index:5;
      display:flex; align-items:center; gap:6px;
      background:#000000aa; border-radius:8px; padding:4px 8px;
    `);
    const icon = mk('span', 'font-size:13px;');
    icon.textContent = '🔊';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '200'; slider.step = '5';
    slider.value = String(Math.round(this.getUserGain(peerId) * 100));
    slider.style.cssText = 'width:90px; accent-color:#3b82f6; cursor:pointer;';
    slider.title = 'Volume';
    const stop = (e) => e.stopPropagation();
    ['click', 'pointerdown', 'mousedown', 'touchstart'].forEach(ev => wrap.addEventListener(ev, stop));
    slider.addEventListener('input', () => {
      const g = Number(slider.value) / 100;
      this.setUserGain(peerId, g);
      icon.textContent = g === 0 ? '🔇' : '🔊';
    });
    wrap.append(icon, slider);
    return wrap;
  }

  // Equal-sized grid that always fits the call view (no scrollbar). The exact
  // column/row counts and per-tile object-fit are computed in _applyGridLayout
  // from the live container size; clicking any cell focuses that participant.
  _buildGridView(participants) {
    const grid = mk('div', `
      flex:1; min-height:0; overflow:hidden; padding:14px;
      display:grid; gap:10px;
    `);
    this._gridVideos = [];
    participants.forEach(p => {
      const cell = mk('div', `
        position:relative; min-width:0; min-height:0;
        border-radius:12px; overflow:hidden; cursor:pointer;
        background:#000; border:2px solid ${p.screen ? '#0ea5e9' : '#334155'};
      `);
      const vid = this._makeExpVideo(p.stream); // object-fit set by _applyGridLayout
      this._maybeMirror(vid, p.key);
      cell.append(vid, this._cellLabel(p.name));
      if (!p.screen) this._applyAvBadges(cell, { audioMuted: p.audioMuted, videoHidden: p.videoHidden, name: p.name }, true);
      if (p.peerId) cell.appendChild(this._volumeSlider(p.peerId));
      cell.addEventListener('click', () => { this._focusedKey = p.key; this._buildExpandedGrid(); });
      grid.appendChild(cell);
      this._gridVideos.push({ video: vid, isScreen: p.screen });
    });
    this._gridEl = grid;
    this._gridCount = participants.length;
    // Wait one frame so the grid has measurable dimensions, then lay it out
    requestAnimationFrame(() => this._applyGridLayout());
    return grid;
  }

  // Pick the column/row split that yields the largest 16:9 tile in the
  // available area (so the grid always fits without scrolling). A cell is never
  // allowed to get too wide-and-short (MAX_CELL_ASPECT) — when the window is
  // narrow, that constraint forces the grid to add a column and shrink the
  // tiles instead of leaving one column of wide strips.
  _applyGridLayout() {
    const grid = this._gridEl;
    const n = this._gridCount;
    if (!grid || !n) return;

    const GAP = 10, PAD = 14;
    const MAX_CELL_ASPECT = 1.9; // height must be at least ~1/1.9 of width
    const rect = grid.getBoundingClientRect();
    const W = (rect.width  || window.innerWidth)  - PAD * 2;
    const H = (rect.height || window.innerHeight) - PAD * 2;

    let best = null;      // best layout respecting the aspect constraint
    let fallback = null;  // best overall, used only if nothing satisfies it
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cellW = (W - (cols - 1) * GAP) / cols;
      const cellH = (H - (rows - 1) * GAP) / rows;
      if (cellW <= 0 || cellH <= 0) continue;
      // largest 16:9 tile that fits inside this cell
      const tileW = Math.min(cellW, cellH * 16 / 9);
      const area = tileW * (tileW * 9 / 16);
      const cand = { cols, rows, area, cellW, cellH };
      if (!fallback || area > fallback.area) fallback = cand;
      if (cellW / cellH <= MAX_CELL_ASPECT && (!best || area > best.area)) best = cand;
    }
    const chosen = best || fallback;

    grid.style.gridTemplateColumns = `repeat(${chosen.cols}, 1fr)`;
    grid.style.gridTemplateRows    = `repeat(${chosen.rows}, 1fr)`;

    const cellAspect = chosen.cellW / chosen.cellH;
    const within16by9 = Math.abs(cellAspect - 16 / 9) / (16 / 9) <= 0.25;
    const camFit = within16by9 ? 'contain' : 'cover';
    this._gridVideos.forEach(({ video, isScreen }) => {
      video.style.objectFit = isScreen ? 'contain' : camFit;
    });
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
    const stageVid = this._makeExpVideo(focused.stream);
    this._maybeMirror(stageVid, focused.key);
    stage.append(stageVid, this._cellLabel(focused.name));
    if (!focused.screen) this._applyAvBadges(stage, { audioMuted: focused.audioMuted, videoHidden: focused.videoHidden, name: focused.name }, true);
    if (focused.peerId) stage.appendChild(this._volumeSlider(focused.peerId));
    const hint = mk('div', `
      position:absolute; top:10px; left:12px; background:#000000aa;
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
      const thumbVid = this._makeExpVideo(p.stream);
      this._maybeMirror(thumbVid, p.key);
      thumb.append(thumbVid, this._cellLabel(p.name, true));
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
      max-height:85vh; overflow-y:auto;
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

    // Camera section: device picker + self-view mirror
    const camLabel = mk('div', 'font-size:11px;color:#64748b;letter-spacing:.05em;margin:22px 0 10px;');
    camLabel.textContent = 'CAMERA';
    const camSelect = this._makeDeviceSelect('videoinput', (id) => {
      this.videoDeviceId = id;
      localStorage.setItem('gs-cam', id || '');
      this._applyDeviceSelection();
    });
    const mirrorRow = this._toggleRadios('gs-mirror',
      'Mirror my video (self-view only)', 'Don’t mirror',
      this.mirrorSelf, (on) => this._setMirror(on));

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

    // Microphone section: device picker + noise suppression
    const nsLabel = mk('div', 'font-size:11px;color:#64748b;letter-spacing:.05em;margin:22px 0 10px;');
    nsLabel.textContent = 'MICROPHONE';
    const micSelect = this._makeDeviceSelect('audioinput', (id) => {
      this.audioDeviceId = id;
      localStorage.setItem('gs-mic', id || '');
      this._applyDeviceSelection();
    });

    const NS_OPTIONS = [
      { on: true,  label: 'Noise reduction: On  (recommended)' },
      { on: false, label: 'Noise reduction: Off' },
    ];
    const nsOptions = mk('div', 'display:flex;flex-direction:column;gap:6px;');
    NS_OPTIONS.forEach(({ on, label }) => {
      const isActive = on === this.noiseSuppression;
      const row = mk('label', `
        display:flex; align-items:center; gap:10px; padding:10px 12px;
        border-radius:8px; cursor:pointer;
        border:1px solid ${isActive ? '#3b82f6' : '#334155'};
        background:${isActive ? '#1e3a5f' : 'transparent'};
        transition:all .15s;
      `);
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gs-noise';
      radio.checked = isActive;
      radio.style.accentColor = '#3b82f6';
      radio.addEventListener('change', () => {
        if (radio.checked) { this._setNoiseSuppression(on); this._closeSettings(); }
      });
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.fontSize = '14px';
      row.append(radio, lbl);
      nsOptions.appendChild(row);
    });

    const nsNote = mk('div', 'font-size:11px;color:#475569;margin-top:14px;line-height:1.5;');
    nsNote.textContent = 'RNNoise (ML) removes background sounds like keyboard typing, fans, and traffic.';

    // Speaker section: loudness maximizer (applies to everyone you hear)
    const spLabel = mk('div', 'font-size:11px;color:#64748b;letter-spacing:.05em;margin:22px 0 10px;');
    spLabel.textContent = 'SPEAKER';
    const maxRow = this._toggleRadios('gs-maximizer',
      'Audio maximizer: On', 'Audio maximizer: Off',
      this.maximizer, (on) => this._setMaximizer(on));
    const spNote = mk('div', 'font-size:11px;color:#475569;margin-top:14px;line-height:1.5;');
    spNote.textContent = 'Boosts and evens out incoming audio so quiet talkers are easier to hear. Adjust individual people with the volume slider on their tile in the call view.';

    panel.append(
      titleRow,
      sectionLabel, options, note,
      camLabel, camSelect, mirrorRow,
      bwLabel, bwOptions, bwNote,
      nsLabel, micSelect, nsOptions, nsNote,
      spLabel, maxRow, spNote,
    );
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
        const sender = this._vSender(peer);
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
    // Docked full-height panel on the right edge. Always present; it shows the
    // nearby chat when someone is in proximity, otherwise the online/DM view.
    this._chat = mk('div', `
      position:fixed; top:0; right:0; bottom:0; width:300px; z-index:100;
      background:#1e293b; border-left:1px solid #334155;
      display:flex; flex-direction:column; overflow:hidden;
      box-shadow:-4px 0 24px #00000066;
    `);

    // Header
    const hdr = mk('div', `
      padding:11px 14px; background:#0f172a; border-bottom:1px solid #334155;
      display:flex; align-items:center; gap:8px; flex-shrink:0;
    `);
    this._chatTitle = mk('span', `
      font-family:monospace;font-size:13px;color:#94a3b8;font-weight:bold;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    `);
    this._chatTitle.textContent = '👥 Online';
    // Padlock next to the zone name (shown only inside a private zone)
    this._zoneLockBtn = mk('button', `
      background:none;border:none;cursor:pointer;padding:0;line-height:0;
      display:none;align-items:center;color:#94a3b8;flex-shrink:0;
    `);
    this._zoneLockIcon = mk('span', 'font-size:18px;');
    this._zoneLockIcon.className = 'material-symbols-outlined';
    this._zoneLockIcon.textContent = 'lock_open';
    this._zoneLockBtn.appendChild(this._zoneLockIcon);
    this._zoneLockBtn.addEventListener('click', () => this.onToggleZoneLock?.());
    const titleWrap = mk('div', 'flex:1; min-width:0; display:flex; align-items:center; gap:6px;');
    titleWrap.append(this._chatTitle, this._zoneLockBtn);
    this._unreadBadge = mk('span', `
      background:#ef4444; color:#fff; font-size:10px;
      border-radius:10px; padding:1px 6px; display:none; font-family:monospace;
    `);
    this._unreadCount = 0;
    // Global DM-unread badge (visible on the always-on-screen header)
    this._dmBadge = mk('span', `
      background:#ef4444; color:#fff; font-size:10px; font-weight:bold;
      border-radius:10px; padding:1px 7px; display:none; font-family:monospace;
    `);
    this._dmBadge.title = 'Unread direct messages';
    this._chatMinimized = true;
    this._chatMinBtn = mk('button', `
      background:#334155; border:none; color:#e2e8f0; font-size:16px;
      width:26px; height:26px; border-radius:6px; cursor:pointer; line-height:1; flex-shrink:0;
    `);
    this._chatMinBtn.textContent = '+';
    this._chatMinBtn.title = 'Expand';
    this._chatMinBtn.addEventListener('click', () => this._toggleChatMinimize());
    hdr.append(titleWrap, this._unreadBadge, this._dmBadge, this._chatMinBtn);

    // Body holds the two views; minimizing hides the body, leaving the header.
    this._chatBody = mk('div', 'flex:1; min-height:0; display:flex; flex-direction:column;');
    this._nearbyView = this._buildNearbyView();
    this._onlineView = this._buildOnlineView();
    this._chatBody.append(this._nearbyView, this._onlineView);

    this._chat.append(hdr, this._chatBody);
    document.body.appendChild(this._chat);

    // Start minimized + in online mode
    this._chatBody.style.display = 'none';
    this._chat.style.bottom = 'auto';
    this._updatePanelMode();
    this._ensureNotifyPermission();

    // When refocusing with a thread open, mark it read + refresh
    this._onWindowFocus = () => {
      if (this._activeDM && !this._chatMinimized) {
        this._dmUnread.set(this._activeDM, 0);
        this._renderDMThread();
        this._renderDMList();
        this._refreshDMBadge();
      }
    };
    window.addEventListener('focus', this._onWindowFocus);
  }

  // ── nearby (proximity) chat view ────────────────────────────────────────────

  _buildNearbyView() {
    const view = mk('div', 'flex:1; min-height:0; display:flex; flex-direction:column;');
    this._chatMessages = mk('div', `
      flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:5px;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);
    const inputRow = mk('div', 'display:flex; gap:6px; padding:8px; border-top:1px solid #334155; flex-shrink:0;');
    this._chatInput = document.createElement('input');
    this._chatInput.type = 'text';
    this._chatInput.placeholder = 'Say something…';
    this._chatInput.maxLength = 300;
    this._chatInput.style.cssText = `
      flex:1; background:#0f172a; color:#e2e8f0; border:1px solid #334155;
      border-radius:6px; padding:6px 8px; font-family:monospace; font-size:12px; outline:none;`;
    this._chatInput.addEventListener('focus', () => {
      this._chatInput.style.borderColor = '#3b82f6';
      this._unreadCount = 0; this._unreadBadge.style.display = 'none';
    });
    this._chatInput.addEventListener('blur', () => this._chatInput.style.borderColor = '#334155');
    this._chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(this._chatInput.value); this._chatInput.value = ''; }
      else if (e.key === 'Escape') this._chatInput.blur();
      e.stopPropagation();
    });
    const sendBtn = this._sendButton(() => { this._sendMessage(this._chatInput.value); this._chatInput.value = ''; this._chatInput.focus(); });
    inputRow.append(this._chatInput, sendBtn);

    // Advisory: nearby / private-area chat is never logged
    const advisory = mk('div', `
      padding:4px 10px; font-family:monospace; font-size:10px; color:#64748b;
      text-align:center; border-top:1px solid #1e293b; flex-shrink:0;
    `);
    advisory.textContent = 'Chats here are not saved';

    view.append(this._chatMessages, advisory, inputRow);
    return view;
  }

  _sendButton(onClick) {
    const b = mk('button', `
      background:#2563eb; border:none; color:#fff; border-radius:6px;
      padding:6px 10px; font-family:monospace; font-size:12px; cursor:pointer;`);
    b.textContent = 'Send';
    b.addEventListener('mouseenter', () => b.style.background = '#1d4ed8');
    b.addEventListener('mouseleave', () => b.style.background = '#2563eb');
    b.addEventListener('click', onClick);
    return b;
  }

  // ── online users + direct-message view ──────────────────────────────────────

  _buildOnlineView() {
    const view = mk('div', 'flex:1; min-height:0; display:flex; flex-direction:column;');

    // Profile header (you)
    const prof = mk('div', `
      display:flex; align-items:center; gap:10px; padding:12px 14px;
      border-bottom:1px solid #334155; flex-shrink:0;
    `);
    const pic = document.createElement('img');
    pic.referrerPolicy = 'no-referrer';
    if (this.localProfile.picture) pic.src = this.localProfile.picture;
    pic.style.cssText = 'width:38px;height:38px;border-radius:50%;background:#334155;flex-shrink:0;';
    const who = mk('div', 'font-family:monospace; min-width:0;');
    const nm = mk('div', 'font-size:13px;color:#e2e8f0;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    nm.textContent = this.localProfile.name;
    const em = mk('div', 'font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    em.textContent = this.localProfile.email || 'guest';
    who.append(nm, em);
    prof.append(pic, who);

    // Direct messages section: list <-> thread
    this._dmListEl = mk('div', `
      flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);
    this._dmThreadEl = mk('div', 'flex:1; min-height:0; display:none; flex-direction:column;');

    // Thread header (back + name)
    const thHdr = mk('div', 'display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid #334155; flex-shrink:0;');
    const back = mk('button', 'background:#334155;border:none;color:#e2e8f0;border-radius:6px;width:26px;height:26px;cursor:pointer;font-family:monospace;');
    back.textContent = '‹';
    back.title = 'Back to people';
    back.addEventListener('click', () => this._closeDM());
    this._dmThreadName = mk('span', 'font-family:monospace;font-size:13px;color:#e2e8f0;font-weight:bold;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    thHdr.append(back, this._dmThreadName);

    this._dmThreadMsgs = mk('div', `
      flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:5px;
      scrollbar-width:thin; scrollbar-color:#334155 transparent;
    `);
    const thInputRow = mk('div', 'display:flex; gap:6px; padding:8px; border-top:1px solid #334155; flex-shrink:0;');
    this._dmInput = document.createElement('input');
    this._dmInput.type = 'text';
    this._dmInput.placeholder = 'Message…';
    this._dmInput.maxLength = 2000;
    this._dmInput.style.cssText = `
      flex:1; background:#0f172a; color:#e2e8f0; border:1px solid #334155;
      border-radius:6px; padding:6px 8px; font-family:monospace; font-size:12px; outline:none;`;
    this._dmInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendDM(); }
      else if (e.key === 'Escape') this._dmInput.blur();
      e.stopPropagation();
    });
    const dmSend = this._sendButton(() => this._sendDM());
    thInputRow.append(this._dmInput, dmSend);
    this._dmThreadEl.append(thHdr, this._dmThreadMsgs, thInputRow);

    view.append(prof, this._dmListEl, this._dmThreadEl);
    return view;
  }

  // ── panel mode + minimize ───────────────────────────────────────────────────

  _hasNearby() {
    return Array.from(this.peers.values()).some(p => p.dc?.readyState === 'open');
  }

  _updatePanelMode() {
    // The ephemeral "area" chat is shown whenever you're in a private zone OR
    // near someone; otherwise the panel is the online/DM view.
    const contextChat = !!this._zoneName || this._hasNearby();
    if (this._nearbyView) this._nearbyView.style.display = contextChat ? 'flex' : 'none';
    if (this._onlineView) this._onlineView.style.display = contextChat ? 'none' : 'flex';
    this._updateHeaderTitle();
  }

  _updateHeaderTitle() {
    if (!this._chatTitle) return;
    this._chatTitle.textContent = this._zoneName
      ? `🔒 ${this._zoneName}`
      : (this._hasNearby() ? '💬 Nearby Chat' : '👥 Online');
  }

  _toggleChatMinimize() {
    this._ensureNotifyPermission();
    this._chatMinimized = !this._chatMinimized;
    const hide = this._chatMinimized;
    this._chatBody.style.display = hide ? 'none' : 'flex';
    // When expanded, sit flush on top of the bottom bar (touching, no gap)
    const barH = this._bar?.offsetHeight || 52;
    this._chat.style.bottom = hide ? 'auto' : `${barH}px`;
    this._chatMinBtn.textContent = hide ? '+' : '–';
    this._chatMinBtn.title = hide ? 'Expand' : 'Minimize';
  }

  // Bar "messages" button: open/close the side panel
  _openMessages() { this._toggleChatMinimize(); }

  // Switch to the nearby view when a data channel opens (panel stays at its
  // current minimized/expanded state; new messages surface via the badge).
  _showChat() { this._updatePanelMode(); }

  _hideChat() { this._updatePanelMode(); } // fall back to online view; panel stays visible

  _appendMessage(name, text, isSelf) {
    this._chatMessages.appendChild(this._bubble(name, text, isSelf));
    this._chatMessages.scrollTop = this._chatMessages.scrollHeight;
    if (document.activeElement !== this._chatInput) {
      this._unreadCount++;
      this._unreadBadge.textContent = this._unreadCount;
      this._unreadBadge.style.display = 'inline';
    }
  }

  _bubble(name, text, isSelf) {
    const row = mk('div', `display:flex; flex-direction:column; gap:2px; align-items:${isSelf ? 'flex-end' : 'flex-start'};`);
    const nameEl = mk('div', 'font-family:monospace;font-size:10px;color:#64748b;padding:0 4px;');
    nameEl.textContent = name;
    const bubble = mk('div', `
      background:${isSelf ? '#1d4ed8' : '#334155'};
      color:#e2e8f0; font-family:monospace; font-size:12px; line-height:1.4; padding:5px 10px;
      border-radius:${isSelf ? '10px 10px 2px 10px' : '10px 10px 10px 2px'};
      max-width:220px; word-break:break-word; white-space:pre-wrap;`);
    bubble.textContent = text;
    row.append(nameEl, bubble);
    return row;
  }

  _sendMessage(text) {
    text = text.trim();
    if (!text) return;
    const payload = JSON.stringify({ t: 'chat', name: this.localName, text });
    this.peers.forEach(peer => { if (peer.dc?.readyState === 'open') peer.dc.send(payload); });
    this._appendMessage(this.localName, text, true);
    this._unreadCount = 0;
    this._unreadBadge.style.display = 'none';
  }

  // ── presence + DM logic ─────────────────────────────────────────────────────

  onPresence(list) {
    this._presence = (list || []).filter(u => u.email !== this.localProfile.email);
    this._renderDMList();
    this._updatePanelMode();
  }

  _renderDMList() {
    const el = this._dmListEl;
    if (!el) return;
    el.innerHTML = '';
    if (!this._presence.length) {
      const empty = mk('div', 'padding:16px;font-family:monospace;font-size:12px;color:#64748b;text-align:center;');
      empty.textContent = 'No other users yet.';
      el.appendChild(empty);
      return;
    }
    // online first, then alphabetical
    const sorted = [...this._presence].sort((a, b) =>
      (b.online - a.online) || a.name.localeCompare(b.name));
    sorted.forEach(u => {
      const row = mk('button', `
        display:flex; align-items:center; gap:10px; padding:10px 14px; width:100%;
        background:none; border:none; border-bottom:1px solid #1e293b; cursor:pointer;
        text-align:left; font-family:monospace;
      `);
      row.addEventListener('mouseenter', () => row.style.background = '#0f172a');
      row.addEventListener('mouseleave', () => row.style.background = 'none');
      const dot = mk('span', `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${u.online ? '#22c55e' : '#475569'};`);
      const pic = document.createElement('img');
      pic.referrerPolicy = 'no-referrer';
      if (u.picture) pic.src = u.picture;
      pic.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#334155;flex-shrink:0;';
      const name = mk('div', 'flex:1;font-size:12px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
      name.textContent = u.name;
      const unread = this._dmUnread.get(u.email) || 0;
      const badge = mk('span', `
        background:#ef4444;color:#fff;font-size:10px;border-radius:10px;padding:1px 6px;
        display:${unread ? 'inline' : 'none'};`);
      badge.textContent = unread;
      row.append(dot, pic, name, badge);
      row.addEventListener('click', () => this._openDM(u.email));
      el.appendChild(row);
    });
  }

  _openDM(email) {
    this._ensureNotifyPermission();
    this._activeDM = email;
    this._dmUnread.set(email, 0);
    this._refreshDMBadge();
    const u = this._presence.find(p => p.email === email);
    this._dmThreadName.textContent = u ? u.name : email;
    this._dmListEl.style.display = 'none';
    this._dmThreadEl.style.display = 'flex';
    this._renderDMThread();
    this.socket?.requestDMHistory(email); // pull persisted history
    setTimeout(() => this._dmInput?.focus(), 30);
  }

  _closeDM() {
    this._activeDM = null;
    this._dmThreadEl.style.display = 'none';
    this._dmListEl.style.display = 'flex';
    this._renderDMList();
  }

  _renderDMThread() {
    const el = this._dmThreadMsgs;
    if (!el) return;
    el.innerHTML = '';
    const msgs = this._dmThreads.get(this._activeDM) || [];
    msgs.forEach(m => {
      const isSelf = m.from === this.localProfile.email;
      el.appendChild(this._bubble(isSelf ? 'You' : (this._presence.find(p => p.email === m.from)?.name || m.from), m.text, isSelf));
    });
    el.scrollTop = el.scrollHeight;
  }

  _sendDM() {
    const text = (this._dmInput.value || '').trim();
    if (!text || !this._activeDM) return;
    this.socket?.sendDM(this._activeDM, text); // server echoes back to us
    this._dmInput.value = '';
  }

  onDMHistory(peer, messages) {
    this._dmThreads.set(peer, messages || []);
    if (this._activeDM === peer) this._renderDMThread();
  }

  onDM(peer, msg) {
    const thread = this._dmThreads.get(peer) || [];
    thread.push(msg);
    this._dmThreads.set(peer, thread);

    const isSelf = msg.from === this.localProfile.email;
    const showingInline = this._activeDM === peer && !this._chatMinimized && !document.hidden;

    if (showingInline) {
      this._renderDMThread();
      return;
    }
    if (isSelf) return; // our own message echoed back while elsewhere

    // Unread: bump per-peer count + the global header badge, refresh list,
    // and raise a desktop notification.
    this._dmUnread.set(peer, (this._dmUnread.get(peer) || 0) + 1);
    this._renderDMList();
    this._refreshDMBadge();
    const u = this._presence.find(p => p.email === peer);
    this._notify(u ? u.name : peer, msg.text, peer);
  }

  _dmTotalUnread() {
    let n = 0;
    this._dmUnread.forEach(c => { n += c; });
    return n;
  }

  _refreshDMBadge() {
    if (!this._dmBadge) return;
    const n = this._dmTotalUnread();
    this._dmBadge.textContent = n > 99 ? '99+' : `✉ ${n}`;
    this._dmBadge.style.display = n > 0 ? 'inline' : 'none';
  }

  // ── desktop notifications ───────────────────────────────────────────────────

  _ensureNotifyPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  _notify(title, body, peerEmail) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(`💬 ${title}`, {
        body: (body || '').slice(0, 140),
        tag: `gs-dm-${peerEmail}`,   // collapse repeats from the same person
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        if (this._chatMinimized) this._toggleChatMinimize();
        this._openDM(peerEmail);
        n.close();
      };
    } catch { /* notifications unsupported in this context */ }
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
        video: {
          width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps },
          ...(this.videoDeviceId ? { deviceId: { exact: this.videoDeviceId } } : { facingMode: 'user' }),
        },
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(this.audioDeviceId ? { deviceId: { exact: this.audioDeviceId } } : {}),
        },
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
      // Route mic audio through the denoiser before peers start sending,
      // so new connections carry the cleaned track.
      if (this.localStream?.getAudioTracks().length) {
        try { await this._setupAudioPipeline(); } catch (e) { console.warn('Audio pipeline:', e); }
      }
      // Unblock proximity/offer handling whether media succeeded or not,
      // so a camera-less machine can still receive others' video & audio.
      this._mediaSettled = true;
    }
  }

  // ── noise suppression ───────────────────────────────────────────────────────

  async _setupAudioPipeline() {
    const audio = this.localStream.getAudioTracks()[0];
    if (!audio) return;
    this._rawAudioTrack = audio;
    if (this.noiseSuppression) {
      try { await this._ensureDenoiser(); }
      catch (e) { console.warn('RNNoise init failed, using raw mic:', e); this._cleanAudioTrack = null; }
    }
    this._applyAudioTrack();
  }

  // Build the RNNoise AudioWorklet graph: raw mic → denoiser → destination.
  // RNNoise expects 48 kHz, so the context is forced to that rate.
  async _ensureDenoiser() {
    if (this._audioCtx && this._cleanAudioTrack) return;
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    const wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const src = ctx.createMediaStreamSource(new MediaStream([this._rawAudioTrack]));
    const dest = ctx.createMediaStreamDestination();
    src.connect(node).connect(dest);
    if (ctx.state === 'suspended') await ctx.resume();
    this._audioCtx = ctx;
    this._denoiseNode = node;
    this._cleanAudioTrack = dest.stream.getAudioTracks()[0];
  }

  // Put the active audio track (clean or raw) into the local stream and all
  // peer senders, preserving the current mute state.
  _applyAudioTrack() {
    const active = (this.noiseSuppression && this._cleanAudioTrack)
      ? this._cleanAudioTrack : this._rawAudioTrack;
    if (!active) return;
    active.enabled = !this.audioMuted;
    if (this._rawAudioTrack && this._rawAudioTrack !== active) {
      this._rawAudioTrack.enabled = true; // keep feeding the denoiser; output gates mute
    }
    const cur = this.localStream.getAudioTracks()[0];
    if (cur && cur !== active) this.localStream.removeTrack(cur);
    if (!this.localStream.getAudioTracks().includes(active)) this.localStream.addTrack(active);
    this.peers.forEach(peer => {
      const sender = this._aSender(peer);
      if (sender && sender.track !== active) sender.replaceTrack(active).catch(() => {});
    });
  }

  async _setNoiseSuppression(on) {
    if (on === this.noiseSuppression) return;
    this.noiseSuppression = on;
    localStorage.setItem('gs-noise', on ? 'on' : 'off');
    if (on && !this._cleanAudioTrack && this._rawAudioTrack) {
      try { await this._ensureDenoiser(); } catch (e) { console.warn('RNNoise init failed:', e); }
    }
    this._applyAudioTrack();
    this._setStatus(on ? '🔇 Noise reduction on' : '🎙️ Noise reduction off', '#86efac');
  }

  // ── mirror & device selection ───────────────────────────────────────────────

  _setMirror(on) {
    this.mirrorSelf = on;
    localStorage.setItem('gs-mirror', on ? 'on' : 'off');
    if (this._localTile?.video) this._localTile.video.style.transform = on ? 'scaleX(-1)' : '';
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  async _populateDeviceSelect(sel, kind) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const currentId = kind === 'videoinput' ? this.videoDeviceId : this.audioDeviceId;
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = ''; def.textContent = 'System default';
      sel.appendChild(def);
      let n = 1;
      devices.filter(d => d.kind === kind).forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${n++}`;
        if (d.deviceId === currentId) o.selected = true;
        sel.appendChild(o);
      });
      if (!currentId) def.selected = true;
    } catch (e) { console.warn('enumerateDevices failed:', e); }
  }

  _makeDeviceSelect(kind, onChange) {
    const sel = document.createElement('select');
    sel.style.cssText = `
      width:100%; background:#0f172a; color:#e2e8f0; border:1px solid #334155;
      border-radius:8px; padding:8px; font-family:monospace; font-size:13px; margin-bottom:6px;
    `;
    this._populateDeviceSelect(sel, kind);
    sel.addEventListener('change', () => onChange(sel.value || null));
    return sel;
  }

  // Re-acquire the mic/camera using the chosen devices and hot-swap the tracks
  // into the local stream, all peers, and (for audio) the denoiser.
  async _applyDeviceSelection() {
    const { w, h, fps } = VIDEO_QUALITIES[this.currentQuality];
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps },
          ...(this.videoDeviceId ? { deviceId: { exact: this.videoDeviceId } } : { facingMode: 'user' }),
        },
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(this.audioDeviceId ? { deviceId: { exact: this.audioDeviceId } } : {}),
        },
      });
    } catch (e) {
      console.error('Device switch failed:', e);
      this._setStatus('⚠️ Could not switch device', '#fca5a5');
      return;
    }

    if (!this.localStream) { this.localStream = stream; this._showLocalStream(); this._mediaSettled = true; }

    const nv = stream.getVideoTracks()[0];
    const na = stream.getAudioTracks()[0];

    if (nv) {
      this.localStream.getVideoTracks().forEach(t => { this.localStream.removeTrack(t); t.stop(); });
      this.localStream.addTrack(nv);
      if (this._localTile?.video) {
        this._localTile.video.srcObject = this.localStream;
        this._localTile.video.style.transform = this.mirrorSelf ? 'scaleX(-1)' : '';
      }
      this.peers.forEach(p => {
        const s = this._vSender(p);
        if (s) s.replaceTrack(nv).catch(() => {});
      });
    }

    if (na) {
      this._rawAudioTrack?.stop();
      this._denoiseNode?.destroy?.();
      this._audioCtx?.close?.();
      this._audioCtx = null; this._denoiseNode = null; this._cleanAudioTrack = null;
      this._rawAudioTrack = na;
      if (this.noiseSuppression) { try { await this._ensureDenoiser(); } catch (e) { console.warn(e); } }
      this._applyAudioTrack();
    }

    if (this._expandedOpen) this._buildExpandedGrid();
    this._setStatus('🟢 Device updated', '#86efac');
  }

  // Two-option radio group (used for On/Off style settings). Closes the modal on pick.
  _toggleRadios(name, onLabel, offLabel, isOn, onPick) {
    const wrap = mk('div', 'display:flex;flex-direction:column;gap:6px;');
    [[true, onLabel], [false, offLabel]].forEach(([val, label]) => {
      const active = val === isOn;
      const row = mk('label', `
        display:flex; align-items:center; gap:10px; padding:10px 12px;
        border-radius:8px; cursor:pointer;
        border:1px solid ${active ? '#3b82f6' : '#334155'};
        background:${active ? '#1e3a5f' : 'transparent'};
      `);
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = name; radio.checked = active;
      radio.style.accentColor = '#3b82f6';
      radio.addEventListener('change', () => { if (radio.checked) { onPick(val); this._closeSettings(); } });
      const lbl = document.createElement('span');
      lbl.textContent = label; lbl.style.fontSize = '14px';
      row.append(radio, lbl);
      wrap.appendChild(row);
    });
    return wrap;
  }

  // Wires a freshly acquired localStream into the local tile and reports
  // real track state — this surfaces "camera held by another app" cases
  // where the stream resolves but no frames ever flow (LED stays off).
  _showLocalStream() {
    if (!this.localStream) return;
    const v = this._localTile.video;
    v.srcObject = this.localStream;
    v.style.transform = this.mirrorSelf ? 'scaleX(-1)' : '';
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
    // Tear down the old denoiser graph so it rebuilds against the new mic
    this._denoiseNode?.destroy?.();
    this._audioCtx?.close?.();
    this._audioCtx = null;
    this._denoiseNode = null;
    this._cleanAudioTrack = null;
    this._rawAudioTrack = null;
    this._setStatus('🎤 Requesting media…', '#64748b');

    this._mediaReadyPromise = this._requestMedia();
    await this._mediaReadyPromise;
    if (!this.localStream) return;

    // Hot-swap new tracks into existing senders (no renegotiation needed)
    this.peers.forEach(peer => {
      this.localStream.getTracks().forEach(track => {
        const sender = track.kind === 'video' ? this._vSender(peer) : this._aSender(peer);
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
    // Drop a dead/closing peer so we re-establish instead of clinging to it
    // (e.g. after the other person left a zone and came back).
    const existing = this.peers.get(peerId);
    if (existing) {
      const st = existing.pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this.closePeer(peerId);
    }
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
    peer.srcNode?.disconnect();
    peer.gainNode?.disconnect();
    peer.compNode?.disconnect();
    peer.audioEl?.remove();
    peer.filmTile?.wrapper.remove();
    this.peers.delete(peerId);
    this._removeScreenPeer(peerId); // close screen peer if one exists
    this._hideChat();
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  // Proximity-driven volume (called each frame by the scene)
  setVolume(peerId, vol) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.proximityVol = vol;
    if (peer.gainNode) this._updatePeerGain(peer);
    else if (peer.audioEl) peer.audioEl.volume = Math.max(0, Math.min(1, vol * (peer.userGain ?? 1)));
  }

  // ── peer connections ──────────────────────────────────────────────────────

  _makePeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.sendIce(peerId, candidate);
    };
    pc.ontrack = (e) => this._onRemoteTrack(peerId, e);
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

  _vSender(peer) { return peer.videoSender || peer.pc.getSenders().find(s => s.track?.kind === 'video'); }
  _aSender(peer) { return peer.audioSender || peer.pc.getSenders().find(s => s.track?.kind === 'audio'); }

  // Always create both an audio and a video sender (sendrecv), with the current
  // local track attached if we have one. Storing the senders means toggling
  // camera/mic later can replaceTrack(null)/replaceTrack(track) reliably even
  // for peers that connected while a device was off.
  _addLocalTracks(peer) {
    const pc = peer.pc;
    const a = this.localStream?.getAudioTracks()[0];
    const v = this.localStream?.getVideoTracks()[0];
    peer.audioSender = a ? pc.addTrack(a, this.localStream) : pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    peer.videoSender = v ? pc.addTrack(v, this.localStream) : pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
  }

  _initiatePeer(peerId) {
    const pc = this._makePeerConnection(peerId);
    const peer = { id: peerId, pc, stream: null, audioEl: null, filmTile: null, dc: null };
    this.peers.set(peerId, peer);
    const dc = pc.createDataChannel('chat', { ordered: true });
    this._setupDataChannel(peerId, dc);
    this._addLocalTracks(peer);
    this._tuneVideoBitrate(pc);
    pc.createOffer()
      .then(o => pc.setLocalDescription(o).then(() => o))
      .then(o => this.socket.sendOffer(peerId, o))
      .catch(console.error);
  }

  // One ontrack fires per track, and tracks may arrive unbundled (no stream).
  // Accumulate every track into a single per-peer MediaStream and build exactly
  // one tile + one audio chain — this prevents the blank duplicate tiles that
  // appeared when the remote attached tracks without a shared stream.
  _onRemoteTrack(peerId, e) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (!peer.stream) peer.stream = (e.streams && e.streams[0]) || new MediaStream();
    if (e.track && !peer.stream.getTracks().includes(e.track)) {
      try { peer.stream.addTrack(e.track); } catch { /* already present */ }
    }
    this._buildRemoteTile(peer, peerId);
    if (e.track?.kind === 'audio') this._buildRemoteAudio(peer);
  }

  _buildRemoteTile(peer, peerId) {
    if (peer.filmTile) return; // build the visual once
    peer.userGain = peer.userGain ?? 1;
    peer.proximityVol = peer.proximityVol ?? 1;
    const name = this.peerNames.get(peerId) || 'Player';
    const tile = this._makeTile(peer.stream, name, false);
    peer.filmTile = tile;
    this._filmstrip.appendChild(tile.wrapper);
    this._refreshPeerBadges(peer);
    if (this._expandedOpen) this._buildExpandedGrid();
  }

  _buildRemoteAudio(peer) {
    if (peer.audioBuilt) return;
    peer.audioBuilt = true;
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = peer.stream;
    document.body.appendChild(audioEl);
    peer.audioEl = audioEl;
    // Route audio through Web Audio for the maximizer + per-user gain. Keep the
    // (muted) element attached — Chrome needs the stream sunk to an element for
    // the MediaStreamAudioSourceNode to receive data.
    try {
      const ctx = this._ensureOutCtx();
      audioEl.muted = true;
      const src = ctx.createMediaStreamSource(peer.stream);
      const gain = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      src.connect(gain); gain.connect(comp); comp.connect(ctx.destination);
      peer.srcNode = src; peer.gainNode = gain; peer.compNode = comp;
      this._applyComp(comp);
      this._updatePeerGain(peer);
    } catch (e) {
      console.warn('Web Audio output failed, using element volume:', e);
      audioEl.muted = false;
      peer.gainNode = null;
    }
  }

  _ensureOutCtx() {
    if (!this._outCtx) this._outCtx = new AudioContext();
    if (this._outCtx.state === 'suspended') this._outCtx.resume();
    return this._outCtx;
  }

  _applyComp(comp) {
    const on = this.maximizer;
    comp.threshold.value = on ? -40 : 0;
    comp.knee.value = on ? 30 : 0;
    comp.ratio.value = on ? 12 : 1;   // ratio 1 ≈ transparent when off
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
  }

  // effective gain = per-user × proximity × maximizer makeup
  _updatePeerGain(peer) {
    if (!peer.gainNode) return;
    const boost = this.maximizer ? 1.8 : 1;
    peer.gainNode.gain.value = Math.max(0, (peer.userGain ?? 1) * (peer.proximityVol ?? 1) * boost);
  }

  // Per-user volume (0 = mute … 1 = normal … 2 = +loud). Used by the call view.
  setUserGain(peerId, g) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.userGain = g;
    if (peer.gainNode) this._updatePeerGain(peer);
    else if (peer.audioEl) peer.audioEl.volume = Math.max(0, Math.min(1, g * (peer.proximityVol ?? 1)));
  }

  getUserGain(peerId) {
    return this.peers.get(peerId)?.userGain ?? 1;
  }

  // Entering/leaving a private zone retitles the panel, switches it to the
  // contextual area chat, and shows the (un)lock padlock for that zone.
  setZoneLabel(name, locked = false) {
    this._zoneName = name || null;
    if (this._zoneLockBtn) {
      this._zoneLockBtn.style.display = name ? 'inline-flex' : 'none';
      this._zoneLockIcon.textContent = locked ? 'lock' : 'lock_open';
      this._zoneLockIcon.style.color = locked ? '#fca5a5' : '#94a3b8';
      this._zoneLockBtn.title = locked ? 'Unlock area' : 'Lock area';
    }
    this._updatePanelMode();
  }

  _setMaximizer(on) {
    this.maximizer = on;
    localStorage.setItem('gs-maximizer', on ? 'on' : 'off');
    this.peers.forEach(peer => {
      if (peer.compNode) this._applyComp(peer.compNode);
      this._updatePeerGain(peer);
    });
    this._setStatus(on ? '🔊 Audio maximizer on' : '🔉 Audio maximizer off', '#86efac');
  }

  _setupDataChannel(peerId, channel) {
    const peer = this.peers.get(peerId);
    if (peer) peer.dc = channel;
    channel.onopen = () => {
      this._showChat();
      this._sendAvStateTo(peer); // tell the newcomer my current mic/cam state
    };
    channel.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'av') {
          if (peer) {
            peer.remoteAudioMuted = !!msg.audioMuted;
            peer.remoteVideoHidden = !!msg.videoHidden;
            this._refreshPeerBadges(peer);
            if (this._expandedOpen) this._buildExpandedGrid();
          }
          return;
        }
        this._appendMessage(msg.name, msg.text, false);
        if (this._chat.style.display === 'none') this._showChat();
      } catch { /* malformed message, ignore */ }
    };
    channel.onclose = () => this._hideChat();
  }

  // ── signaling ─────────────────────────────────────────────────────────────

  async onOffer({ fromId, offer }) {
    // Wait for media to settle instead of dropping the offer — this is the fix
    // for connections failing on first login until players walk apart & back.
    await this._mediaReadyPromise;
    // A fresh offer supersedes any existing/stale peer (e.g. one left over from
    // before the sender left and re-entered a private zone). Closing + accepting
    // re-establishes the call instead of rejecting the offer.
    if (this.peers.has(fromId)) this.closePeer(fromId);

    const pc = this._makePeerConnection(fromId);
    const peer = { id: fromId, pc, stream: null, audioEl: null, filmTile: null, dc: null };
    this.peers.set(fromId, peer);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    // Attach our tracks with addTrack(track, localStream) so they're bundled in
    // a MediaStream — this is what makes the offerer's ontrack receive a proper
    // streams[0] (otherwise it gets blank, duplicated tiles). addTrack reuses
    // the offer's recvonly transceivers. For tracks we don't have (camera off),
    // capture the existing transceiver's sender so toggling-on works later.
    const a = this.localStream?.getAudioTracks()[0];
    const v = this.localStream?.getVideoTracks()[0];
    if (a) peer.audioSender = pc.addTrack(a, this.localStream);
    if (v) peer.videoSender = pc.addTrack(v, this.localStream);
    pc.getTransceivers().forEach(tr => {
      const kind = tr.receiver.track?.kind;
      if (kind === 'audio' && !peer.audioSender) peer.audioSender = tr.sender;
      if (kind === 'video' && !peer.videoSender) peer.videoSender = tr.sender;
    });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.sendAnswer(fromId, answer);
    this._tuneVideoBitrate(pc);
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
    if (this._onEscKey) document.removeEventListener('keydown', this._onEscKey);
    if (this._onWindowFocus) window.removeEventListener('focus', this._onWindowFocus);
    this.peers.forEach((_, id) => this.closePeer(id));
    this._stopScreenShare();
    this._denoiseNode?.destroy?.();
    this._audioCtx?.close?.();
    this._outCtx?.close?.();
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
