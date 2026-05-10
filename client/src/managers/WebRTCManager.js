// Manages proximity-based WebRTC peer connections.
// Uses free Google STUN servers. For cross-network use, add a TURN server to ICE_SERVERS.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class WebRTCManager {
  constructor(socketManager) {
    this.socket = socketManager;
    // peerId -> { pc, audioEl, videoWrapper }
    this.peers = new Map();
    this.localStream = null;

    this._buildUI();
    this._requestMedia();
  }

  // ── UI shell ──────────────────────────────────────────────────────────────

  _buildUI() {
    // Video tile strip — bottom-left corner
    this.videoStrip = document.createElement('div');
    this.videoStrip.style.cssText = `
      position:fixed; bottom:14px; left:14px;
      display:flex; gap:8px; flex-wrap:wrap; max-width:420px; z-index:100;
    `;
    document.body.appendChild(this.videoStrip);

    // Local self-view
    this.localVideo = document.createElement('video');
    this.localVideo.autoplay = true;
    this.localVideo.muted = true;
    this.localVideo.playsInline = true;
    this.localVideo.style.cssText = `
      width:120px; height:90px; border-radius:8px; object-fit:cover;
      background:#0f172a; border:2px solid #334155; display:none;
    `;
    this.videoStrip.appendChild(this.localVideo);

    // Status badge
    this.statusBadge = document.createElement('div');
    this.statusBadge.style.cssText = `
      position:fixed; top:14px; right:14px; z-index:100;
      background:#1e293b; border:1px solid #334155; border-radius:8px;
      font-family:monospace; font-size:12px; padding:6px 10px; color:#64748b;
    `;
    this.statusBadge.textContent = '🎤 Requesting media…';
    document.body.appendChild(this.statusBadge);
  }

  async _requestMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      this.localVideo.srcObject = this.localStream;
      this.localVideo.style.display = 'block';
      this._setStatus('🟢 Camera + mic ready', '#86efac');
    } catch (_) {
      // Fall back to audio only
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._setStatus('🎤 Audio only', '#fde68a');
      } catch (_2) {
        this._setStatus('❌ No media access', '#fca5a5');
      }
    }
  }

  _setStatus(text, color) {
    if (!this.statusBadge) return;
    this.statusBadge.textContent = text;
    this.statusBadge.style.color = color;
  }

  // ── proximity callbacks (called from GameScene) ───────────────────────────

  onNearby(peerId) {
    if (this.peers.has(peerId) || !this.localStream) return;
    // Only the "lesser" socket ID initiates to avoid duplicate offers
    if ((this.socket.id ?? '') < peerId) {
      this._initiatePeer(peerId);
    }
    // The other side will receive the offer and call onOffer()
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audioEl?.remove();
    peer.videoWrapper?.remove();
    this.peers.delete(peerId);
  }

  setVolume(peerId, vol) {
    const peer = this.peers.get(peerId);
    if (peer?.audioEl) peer.audioEl.volume = Math.max(0, Math.min(1, vol));
  }

  // ── peer connection factory ───────────────────────────────────────────────

  _makePeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.sendIce(peerId, candidate);
    };

    pc.ontrack = ({ streams }) => {
      this._attachRemoteStream(peerId, streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closePeer(peerId);
      }
    };

    return pc;
  }

  _initiatePeer(peerId) {
    const pc = this._makePeerConnection(peerId);
    this.peers.set(peerId, { pc, audioEl: null, videoWrapper: null });

    this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer).then(() => offer))
      .then(offer => this.socket.sendOffer(peerId, offer))
      .catch(console.error);
  }

  _attachRemoteStream(peerId, stream) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.videoWrapper) return; // already attached

    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position:relative; border-radius:8px; overflow:hidden;
      border:2px solid #3b82f6; background:#0f172a;
      width:120px; height:90px;
    `;

    if (stream.getVideoTracks().length > 0) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.style.cssText = `width:100%; height:100%; object-fit:cover; display:block;`;
      wrapper.appendChild(video);
    } else {
      const ph = document.createElement('div');
      ph.style.cssText = `
        width:100%; height:100%; display:flex; align-items:center;
        justify-content:center; font-size:28px; background:#1e293b;
      `;
      ph.textContent = '🎤';
      wrapper.appendChild(ph);
    }

    // Hidden <audio> carries the actual audio output (avoids echo from video el)
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    document.body.appendChild(audio);

    peer.audioEl = audio;
    peer.videoWrapper = wrapper;
    this.videoStrip.appendChild(wrapper);
  }

  // ── signaling handlers (called from SocketManager) ────────────────────────

  async onOffer({ fromId, offer }) {
    if (this.peers.has(fromId) || !this.localStream) return;

    const pc = this._makePeerConnection(fromId);
    this.peers.set(fromId, { pc, audioEl: null, videoWrapper: null });

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
    } catch { /* benign if ICE is already settled */ }
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    this.peers.forEach((_, id) => this.closePeer(id));
    this.localStream?.getTracks().forEach(t => t.stop());
    this.videoStrip?.remove();
    this.statusBadge?.remove();
  }
}
