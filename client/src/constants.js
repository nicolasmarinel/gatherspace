export const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

export const PLAYER_SPEED = 200;
export const MAP_WIDTH = 2400;
export const MAP_HEIGHT = 1800;

// Distance at which WebRTC connections open / close (hysteresis prevents flutter)
export const PROXIMITY_OPEN_DIST = 220;
export const PROXIMITY_CLOSE_DIST = 300;

export const AVATAR_COLORS = [
  { body: 0xe74c3c, dark: 0xc0392b, label: 'Red' },
  { body: 0x3498db, dark: 0x2980b9, label: 'Blue' },
  { body: 0x2ecc71, dark: 0x27ae60, label: 'Green' },
  { body: 0x9b59b6, dark: 0x8e44ad, label: 'Purple' },
  { body: 0xe67e22, dark: 0xd35400, label: 'Orange' },
  { body: 0x1abc9c, dark: 0x16a085, label: 'Teal' },
  { body: 0xe91e63, dark: 0xc2185b, label: 'Pink' },
  { body: 0xf1c40f, dark: 0xf39c12, label: 'Yellow' },
];
