import Phaser from 'phaser';
import { AVATAR_COLORS } from '../constants.js';

export class LobbyScene extends Phaser.Scene {
  constructor() {
    super('Lobby');
    this.selectedAvatar = 0;
    this._overlay = null;
  }

  create() {
    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, 0x1a202c).setOrigin(0);

    // Title
    this.add.text(width / 2, 70, 'GatherSpace', {
      fontSize: '44px', color: '#60a5fa', fontFamily: 'monospace', fontStyle: 'bold'
    }).setOrigin(0.5);
    this.add.text(width / 2, 118, 'a cozy self-hosted virtual workspace', {
      fontSize: '16px', color: '#64748b', fontFamily: 'monospace'
    }).setOrigin(0.5);

    // Build the form as a plain HTML overlay — more reliable than Phaser DOM for forms
    this._buildOverlay(width, height);
  }

  _buildOverlay(w, h) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
      pointer-events:none; z-index:10;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      pointer-events:all;
      background:#1e293b; border:1px solid #334155; border-radius:16px;
      padding:32px 40px; display:flex; flex-direction:column; gap:16px;
      font-family:monospace; color:#e2e8f0; width:360px;
    `;

    card.innerHTML = `
      <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:#94a3b8">
        YOUR NAME
        <input id="gs-name" type="text" maxlength="20" placeholder="e.g. Nico"
          style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;
                 padding:10px 12px;font-size:16px;font-family:monospace;outline:none;">
      </label>
      <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:#94a3b8">
        ROOM ID
        <input id="gs-room" type="text" maxlength="24" value="main"
          style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;
                 padding:10px 12px;font-size:16px;font-family:monospace;outline:none;">
      </label>
      <div style="font-size:13px;color:#94a3b8">AVATAR COLOR</div>
      <div id="gs-avatars" style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center"></div>
      <button id="gs-join"
        style="background:#2563eb;color:#fff;border:none;border-radius:8px;
               padding:12px;font-size:17px;font-family:monospace;font-weight:bold;
               cursor:pointer;margin-top:4px;">
        Join Space →
      </button>
    `;

    // Avatar color picker
    const avatarRow = card.querySelector('#gs-avatars');
    AVATAR_COLORS.forEach((c, i) => {
      const hex = '#' + c.body.toString(16).padStart(6, '0');
      const btn = document.createElement('button');
      btn.dataset.idx = i;
      btn.style.cssText = `
        width:36px;height:36px;border-radius:50%;background:${hex};cursor:pointer;
        border:3px solid ${i === 0 ? '#fff' : 'transparent'};transition:border-color .15s;
      `;
      btn.title = c.label;
      btn.addEventListener('click', () => {
        avatarRow.querySelectorAll('button').forEach(b => b.style.borderColor = 'transparent');
        btn.style.borderColor = '#fff';
        this.selectedAvatar = i;
      });
      avatarRow.appendChild(btn);
    });

    const joinBtn = card.querySelector('#gs-join');
    joinBtn.addEventListener('mouseover', () => joinBtn.style.background = '#1d4ed8');
    joinBtn.addEventListener('mouseout', () => joinBtn.style.background = '#2563eb');
    joinBtn.addEventListener('click', () => this._join());

    card.querySelector('#gs-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._join();
    });
    card.querySelector('#gs-room').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._join();
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Auto-focus name field
    setTimeout(() => card.querySelector('#gs-name').focus(), 100);
  }

  _join() {
    const name = (document.getElementById('gs-name')?.value || '').trim() || 'Anonymous';
    const roomId = (document.getElementById('gs-room')?.value || '').trim() || 'main';

    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }

    this.scene.start('Game', { name, avatarIndex: this.selectedAvatar, roomId });
  }

  shutdown() {
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }
  }
}
