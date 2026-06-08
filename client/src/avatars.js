// Custom Gather avatar spritesheets.
//
// Each custom avatar occupies a global avatar index starting at N_COLORS — the
// 8 procedural color avatars keep indices 0–7 — so the numeric `avatar` field
// travels over the network unchanged. To add a friend's avatar: drop their
// sheet in client/public/avatars/ and append an entry to CUSTOM_AVATARS.
//
// Sheet layout: a single row of 16 frames, 32×64 each (Gather's format):
//   0 down-idle   1 down-walkA   2 down-walkB
//   3 left-idle   4 left-walkA   5 left-walkB
//   6 up-idle     7 up-walkA     8 up-walkB
//   9 right-idle 10 right-walkA 11 right-walkB
//  12–15 dance

export const N_COLORS = 8;

export const CUSTOM_AVATARS = [
  { label: 'Nico', sheet: '/avatars/avatar-1.png' },
  { label: 'Kat', sheet: '/avatars/avatar-2.png' },
];

export const FRAME_W = 32;
export const FRAME_H = 64;

export const POSES = {
  down:  { idle: 0, walk: [1, 2] },
  left:  { idle: 3, walk: [4, 5] },
  up:    { idle: 6, walk: [7, 8] },
  right: { idle: 9, walk: [10, 11] },
};
export const DANCE_FRAMES = [12, 13, 14, 15];

export function isCustomAvatar(index) { return index >= N_COLORS; }
export function customAt(index) { return CUSTOM_AVATARS[index - N_COLORS] || null; }
export function sheetKey(index) { return `avsheet-${index}`; }
export function walkAnimKey(index, dir) { return `a${index}-${dir}-walk`; }
export function danceAnimKey(index) { return `a${index}-dance`; }

// Initial texture args for a sprite of this avatar (custom falls back to a
// color avatar if its sheet isn't in this client's registry).
export function idleTextureArgs(index) {
  if (isCustomAvatar(index)) {
    if (customAt(index)) return [sheetKey(index), POSES.down.idle];
    return ['avatar-0-down']; // unknown custom avatar → safe fallback
  }
  return [`avatar-${index}-down`];
}
