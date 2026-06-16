// Picture-in-Picture: when the tab is hidden, float a small window showing the
// 5x5-tile area around the local avatar — or, if a call is active, the call's
// video. A canvas is fed to a <video> via captureStream, and that video is what
// enters PiP (so its content can switch live between minimap and call).
//
// Entering PiP requires a user activation, and switching tabs is NOT one — so
// the request only succeeds when activation is still live (a gesture within the
// last few seconds, e.g. moving the avatar before switching away). We keep one
// persistent pipeline alive and continuously drawn so the capture stream never
// stalls and the video is always ready for an instant, synchronous request.
//
// (The Media Session "enterpictureinpicture" action would allow gesture-free
// auto-PiP, but it triggers Chrome's "Automatic Picture-in-Picture" permission
// and its own auto-PiP logic, which proved unpredictable — wrong video / wrong
// size / broken re-entry — so we don't use it.)

const SIZE = 320;        // PiP canvas px (square)
const WINDOW_TILES = 5;  // 5x5 tiles around the avatar

export class PiPManager {
  constructor(scene) {
    this.scene = scene;

    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
      this._unsupported = true;
      return;
    }

    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE; this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d');

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.cssText = 'position:fixed; left:-9999px; width:2px; height:2px; opacity:0; pointer-events:none;';
    try { this.video.srcObject = this.canvas.captureStream(30); }
    catch { this._unsupported = true; return; }
    document.body.appendChild(this.video);

    // Keep the canvas continuously drawn so the capture stream never stalls and
    // the video stays ready+playing for an instant, synchronous PiP request.
    this._draw();
    this._timer = setInterval(() => this._draw(), 66); // ~15fps
    const p = this.video.play(); if (p?.catch) p.catch(() => {});
    // If the browser ever pauses it, resume so it's ready next switch.
    this.video.addEventListener('pause', () => { const r = this.video?.play(); if (r?.catch) r.catch(() => {}); });

    this._onVis = () => { if (document.hidden) this._requestPiP(); else this._exitPiP(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  // Manual toggle (from the bottom-bar button). The click is a user gesture, so
  // this entry always works regardless of activation state.
  toggle() {
    if (this._unsupported) { return false; }
    if (document.pictureInPictureElement === this.video) this._exitPiP();
    else this._requestPiP();
    return true;
  }

  _requestPiP() {
    const v = this.video;
    if (this._unsupported || !v) return;
    if (document.pictureInPictureElement === v) return;
    const p = v.play(); if (p?.catch) p.catch(() => {});
    // Must stay synchronous (no await) to preserve the activation
    const r = v.requestPictureInPicture(); if (r?.catch) r.catch(() => {});
  }

  _exitPiP() {
    if (this._unsupported) return;
    if (document.pictureInPictureElement === this.video) {
      const r = document.exitPictureInPicture(); if (r?.catch) r.catch(() => {});
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const videos = this.scene.webRTC?.getCallVideos?.() || [];
    if (videos.length) this._drawCall(videos);
    else this._drawMinimap();
  }

  // ── 5x5 area around the avatar ──────────────────────────────────────────────

  _drawMinimap() {
    const lp = this.scene.localPlayer;
    if (!lp) return;
    const ctx = this.ctx;
    const T = this.scene._mapTile || 32;
    const win = WINDOW_TILES * T;
    const cx = lp.sprite.x, cy = lp.sprite.y;
    const ox = cx - win / 2, oy = cy - win / 2;
    const scale = SIZE / win;

    ctx.imageSmoothingEnabled = false;
    const bg = this.scene.textures?.exists('bg-map')
      ? this.scene.textures.get('bg-map').getSourceImage() : null;
    if (bg) {
      ctx.drawImage(bg, ox, oy, win, win, 0, 0, SIZE, SIZE);
    } else {
      ctx.fillStyle = '#1f2937'; ctx.fillRect(0, 0, SIZE, SIZE);
    }

    const drawAvatar = (sprite, wx, wy) => {
      if (wx < ox - T || wx > ox + win + T || wy < oy - T * 2 || wy > oy + win + T) return;
      const fr = sprite.frame;
      const src = sprite.texture.getSourceImage();
      const dw = fr.cutWidth * scale, dh = fr.cutHeight * scale;
      const dx = (wx - ox) * scale - dw / 2;
      const dy = (wy - oy) * scale - dh / 2;
      try { ctx.drawImage(src, fr.cutX, fr.cutY, fr.cutWidth, fr.cutHeight, dx, dy, dw, dh); } catch { /* ignore */ }
    };

    // Remotes use their target (server) position so they keep moving while hidden
    this.scene.remotePlayers?.forEach(rp => drawAvatar(rp.sprite, rp.targetX ?? rp.sprite.x, rp.targetY ?? rp.sprite.y));
    drawAvatar(lp.sprite, cx, cy);

    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, SIZE - 3, SIZE - 3);
  }

  // ── active call ─────────────────────────────────────────────────────────────

  _drawCall(parts) {
    const ctx = this.ctx;
    const n = Math.min(parts.length, 4);
    const cols = n <= 1 ? 1 : 2;
    const rows = Math.ceil(n / cols);
    const cw = SIZE / cols, ch = SIZE / rows;
    for (let i = 0; i < n; i++) {
      const { video: v, name, videoHidden } = parts[i];
      const col = i % cols, row = Math.floor(i / cols);
      const dx = col * cw, dy = row * ch;
      const hasFrame = !videoHidden && v.readyState >= 2 && v.videoWidth;
      if (hasFrame) {
        ctx.imageSmoothingEnabled = true;
        const s = Math.max(cw / v.videoWidth, ch / v.videoHeight);
        const w = v.videoWidth * s, h = v.videoHeight * s;
        try { ctx.drawImage(v, dx + (cw - w) / 2, dy + (ch - h) / 2, w, h); } catch { /* ignore */ }
      } else {
        // Camera off: avatar-initial placeholder
        ctx.fillStyle = '#0f172a'; ctx.fillRect(dx, dy, cw, ch);
        ctx.fillStyle = '#334155';
        ctx.beginPath(); ctx.arc(dx + cw / 2, dy + ch / 2 - 6, Math.min(cw, ch) * 0.18, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#e2e8f0';
        ctx.font = `${Math.round(Math.min(cw, ch) * 0.18)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((name || '?').charAt(0).toUpperCase(), dx + cw / 2, dy + ch / 2 - 6);
      }
      // Name label
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(dx, dy + ch - 18, cw, 18);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name || 'Player', dx + 5, dy + ch - 9);
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1;
      ctx.strokeRect(dx, dy, cw, ch);
    }
  }

  destroy() {
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this._timer) clearInterval(this._timer);
    this._exitPiP();
    if (this.video) {
      try { this.video.srcObject?.getTracks?.().forEach(t => t.stop()); } catch { /* ignore */ }
      this.video.remove();
    }
  }
}
