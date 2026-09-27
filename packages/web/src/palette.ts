/** Warm kitchen palette. Every scene colour comes from here. */
export const palette = {
  night: 0x2b1d14,
  sky: 0x3a2618,
  floorTile: 0xd9b48f,
  floorGrout: 0xb8916c,
  wall: 0xf1dcc0,
  wallTrim: 0xa8683f,
  tileSplash: 0xe9cfae,
  counter: 0x8a5a3b,
  counterTop: 0xe8dccb,
  copper: 0xc8753f,
  steel: 0xb9b2aa,
  darkSteel: 0x5b524c,
  wood: 0xa26b43,
  woodDark: 0x6e4428,
  door: 0x7b4a2c,
  doorKnob: 0xe0b04a,
  patio: 0x9c8672,
  grass: 0x6f8a4a,
  leaf: 0x7fa052,
  tomato: 0xd9573b,
  carrot: 0xe8913a,
  flame: 0xff9a3c,
  lampLight: 0xffd6a0,
  lampShade: 0x3f2f25,
  ambient: 0xffe8cc,
  cream: 0xfbe9d0,
  jacket: 0xfaf4ea,
  trousers: 0x3b302b,
  skin: 0xf2c9a0,
  blush: 0xf0927a,
  eye: 0x2b1d14,
  hat: 0xffffff,
  plate: 0xfdfaf4,
  brass: 0xe0b04a,
  mug: 0x5e8c9c,
  coffee: 0x4a2c1a,
  ticket: 0xfff8ea,
  ticketInk: 0x3b2a1f,
  ticketAccent: 0xc8753f,
  /** Aprons for observed cooks, picked by a hash of the session id. */
  aprons: [0xc8753f, 0x6f9a8d, 0xd6a13c, 0x9b6fa6, 0x5f86b8, 0xc4596a, 0x7fa052, 0xb07a52],
  /** Crew aprons use the persona hue with this saturation and lightness. */
  crewApron: { s: 0.55, l: 0.55 },
} as const;

/** `#rrggbb` for CSS. */
export function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
