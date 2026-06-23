// Private post-it notes left on other users' claimed desks.
//
// Flow: author opens the desk menu → "Post-it" → a big yellow note appears in
// the centre of the screen to write on → "Place" → a small note follows the
// pointer → click the recipient's claimed area to drop it. The recipient sees a
// small yellow square on their desk; clicking it opens the note with Discard /
// Keep. Notes are visible only to author + recipient (enforced server-side).

const NOTE_FILL = 0xfde047;   // yellow
const NOTE_STROKE = 0xca8a04;
const NOTE_DEPTH = 3.5;       // on the desk, just under avatars

export class PostitManager {
  constructor(scene) {
    this.scene = scene;
    this._notes = new Map();   // id -> note
    this._sprites = new Map(); // id -> { rect, icon }
    this._placing = null;      // { mode:'place'|'move', toEmail, text?, id? }
    this._carry = null;        // DOM square following the pointer
    this._overlay = null;      // big post-it DOM
    this._hint = null;

    this._onMove = (e) => {
      if (this._carry) { this._carry.style.left = `${e.clientX}px`; this._carry.style.top = `${e.clientY}px`; }
    };
    this._onKey = (e) => { if (e.key === 'Escape') this._endPlacing(); };
  }

  // ── socket events ───────────────────────────────────────────────────────────

  onPostits(list) {
    this._sprites.forEach(s => this._destroySprite(s));
    this._sprites.clear();
    this._notes.clear();
    (list || []).forEach(n => { this._notes.set(n.id, n); this._renderNote(n); });
  }

  onAdded(note) {
    this._notes.set(note.id, note);
    this._renderNote(note);
  }

  onUpdated({ id, text }) {
    const n = this._notes.get(id);
    if (!n) return;
    n.text = text;
    if (this._overlay?.dataset.noteId === id && this._overlay._textEl && !this._overlay._editable) {
      this._overlay._textEl.textContent = text;
    }
  }

  onMoved({ id, x, y }) {
    const n = this._notes.get(id);
    if (!n) return;
    n.x = x; n.y = y;
    const s = this._sprites.get(id);
    if (s) { s.rect.setPosition(x, y); s.icon.setPosition(x, y); }
  }

  onRemoved(id) {
    const s = this._sprites.get(id);
    if (s) { this._destroySprite(s); this._sprites.delete(id); }
    this._notes.delete(id);
    if (this._overlay?.dataset.noteId === id) this._closeOverlay();
  }

  // ── map squares ───────────────────────────────────────────────────────────

  _renderNote(note) {
    if (this._sprites.has(note.id)) { this.onMoved(note); return; }
    const T = this.scene._mapTile || 32;
    const size = Math.round(T * 0.66);
    const rect = this.scene.add.rectangle(note.x, note.y, size, size, NOTE_FILL)
      .setStrokeStyle(2, NOTE_STROKE).setDepth(NOTE_DEPTH);
    const icon = this.scene.add.text(note.x, note.y, '📝', { fontSize: `${Math.round(size * 0.6)}px` })
      .setOrigin(0.5).setDepth(NOTE_DEPTH + 0.01);
    this._sprites.set(note.id, { rect, icon });
  }

  _destroySprite(s) { s.rect.destroy(); s.icon.destroy(); }

  // Topmost note whose square contains the world point (for tap routing)
  noteAt(wx, wy) {
    let hit = null;
    this._sprites.forEach((s, id) => {
      const b = s.rect.getBounds();
      if (wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom) hit = this._notes.get(id);
    });
    return hit;
  }

  // ── placing mode ────────────────────────────────────────────────────────────

  isPlacing() { return !!this._placing; }

  _beginPlacing(p) {
    this._endPlacing();
    this._placing = p;
    const c = document.createElement('div');
    c.style.cssText = `position:fixed; z-index:320; width:22px; height:22px;
      background:#fde047; border:1px solid #ca8a04; border-radius:3px; transform:translate(-50%,-50%);
      pointer-events:none; box-shadow:0 2px 6px #0007;`;
    document.body.appendChild(c);
    this._carry = c;
    this._hint = this._banner('Click the desk to place the note · Esc to cancel');
    window.addEventListener('pointermove', this._onMove, true);
    window.addEventListener('keydown', this._onKey, true);
  }

  _endPlacing() {
    this._placing = null;
    this._carry?.remove(); this._carry = null;
    this._hint?.remove(); this._hint = null;
    window.removeEventListener('pointermove', this._onMove, true);
    window.removeEventListener('keydown', this._onKey, true);
  }

  // Called by the scene when the user clicks/taps the world while placing
  tryPlaceAt(wx, wy) {
    if (!this._placing) return;
    const zid = this.scene._zoneAt(wx, wy);
    const z = zid != null ? this.scene._zoneById?.get(zid) : null;
    if (!z || z.owner !== this._placing.toEmail) { this._flashBanner('Place it on their desk'); return; }
    if (this._placing.mode === 'move') this.scene.socket?.sendPostitMove(this._placing.id, wx, wy);
    else this.scene.socket?.sendPostitPlace(this._placing.toEmail, this._placing.text, wx, wy);
    this._endPlacing();
  }

  // ── authoring / viewing ──────────────────────────────────────────────────────

  // Desk menu → "Post-it": write a new note for the desk owner
  startAuthoring(toEmail, toName) {
    this._openOverlay({
      noteId: '', title: `Note for ${toName}`, text: '', editable: true,
      buttons: [{ label: 'Place', primary: true, onClick: (getText) => {
        const text = getText().trim();
        this._closeOverlay();
        this._beginPlacing({ mode: 'place', toEmail, text });
      } }],
    });
  }

  openNote(id) {
    const note = this._notes.get(id);
    if (!note) return;
    const me = this.scene._myEmail();
    if (note.to === me) this._openRecipientView(note);
    else if (note.from === me) this._openAuthorView(note);
  }

  _openRecipientView(note) {
    this._openOverlay({
      noteId: note.id, title: `Note from ${note.fromName || note.from}`, text: note.text, editable: false,
      buttons: [
        { label: 'Discard', onClick: () => this._confirmDiscard(note.id) },
        { label: 'Keep', primary: true, onClick: () => {
          this._closeOverlay();
          this._beginPlacing({ mode: 'move', id: note.id, toEmail: this.scene._myEmail() });
        } },
      ],
    });
  }

  _openAuthorView(note) {
    this._openOverlay({
      noteId: note.id, title: 'Your note', text: note.text, editable: true,
      buttons: [
        { label: 'Delete', onClick: () => this._confirmDiscard(note.id) },
        { label: 'Save', primary: true, onClick: (getText) => {
          this.scene.socket?.sendPostitUpdate(note.id, getText());
          this._closeOverlay();
        } },
      ],
    });
  }

  // ── overlay UI ───────────────────────────────────────────────────────────────

  _openOverlay({ noteId, title, text, editable, buttons }) {
    this._closeOverlay();
    const wrap = document.createElement('div');
    wrap.dataset.noteId = noteId;
    wrap._editable = editable;
    wrap.style.cssText = `position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:320; width:280px; background:#fde047; color:#422006; border-radius:6px;
      box-shadow:0 16px 48px #000a, inset 0 0 0 1px #00000014; padding:14px;
      font-family:'Comic Sans MS', 'Segoe Print', monospace; display:flex; flex-direction:column; gap:10px;`;

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'font-size:13px; font-weight:bold; opacity:0.8; padding-right:20px;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = `position:absolute; top:8px; right:10px; background:none; border:none;
      color:#422006; font-size:15px; cursor:pointer; opacity:0.6; line-height:1;`;
    closeBtn.addEventListener('click', () => this._closeOverlay());

    let textEl, getText;
    if (editable) {
      textEl = document.createElement('textarea');
      textEl.value = text || '';
      textEl.maxLength = 500;
      textEl.placeholder = 'Write a note…';
      textEl.style.cssText = `width:100%; height:150px; resize:none; border:none; outline:none;
        background:#fef9c3; color:#422006; border-radius:4px; padding:8px;
        font-family:inherit; font-size:15px; line-height:1.4; box-sizing:border-box;`;
      textEl.addEventListener('keydown', e => e.stopPropagation());
      setTimeout(() => textEl.focus(), 30);
      getText = () => textEl.value;
    } else {
      textEl = document.createElement('div');
      textEl.textContent = text || '';
      textEl.style.cssText = `min-height:150px; white-space:pre-wrap; word-break:break-word;
        font-size:15px; line-height:1.4; padding:4px;`;
      getText = () => text || '';
    }
    wrap._textEl = textEl;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
    buttons.forEach(b => btnRow.appendChild(this._btn(b.label, b.primary, () => b.onClick(getText))));

    wrap.append(closeBtn, titleEl, textEl, btnRow);
    document.body.appendChild(wrap);
    this._overlay = wrap;
  }

  // Inline "are you sure?" before deleting
  _confirmDiscard(id) {
    if (!this._overlay) return;
    const row = this._overlay.lastChild;
    row.innerHTML = '';
    const q = document.createElement('span');
    q.textContent = 'Discard this note?';
    q.style.cssText = 'font-size:13px; align-self:center; margin-right:auto;';
    row.appendChild(q);
    row.appendChild(this._btn('No', false, () => this._closeOverlay()));
    row.appendChild(this._btn('Yes, discard', true, () => {
      this.scene.socket?.sendPostitDelete(id);
      this._closeOverlay();
    }));
  }

  _btn(label, primary, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `border:none; border-radius:6px; cursor:pointer; padding:7px 12px;
      font-family:monospace; font-size:12px; font-weight:bold;
      background:${primary ? '#ca8a04' : '#00000018'}; color:${primary ? '#fff' : '#422006'};`;
    b.addEventListener('click', onClick);
    return b;
  }

  _closeOverlay() { this._overlay?.remove(); this._overlay = null; }

  _banner(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed; left:50%; top:18px; transform:translateX(-50%); z-index:321;
      background:#1a202cee; color:#fde68a; font-family:monospace; font-size:13px;
      padding:8px 14px; border-radius:8px; pointer-events:none;`;
    document.body.appendChild(el);
    return el;
  }

  _flashBanner(msg) { if (this._hint) this._hint.textContent = msg; }

  destroy() {
    this._endPlacing();
    this._closeOverlay();
    this._sprites.forEach(s => this._destroySprite(s));
    this._sprites.clear();
  }
}
