// Inline SVG icon set used by items, abilities, upgrades, HUD and the
// phone controller. Single colour (currentColor) so the same path renders
// correctly on dark/light/coloured backgrounds — set the surrounding text
// colour and the icon follows.
//
// Icons are 24×24 viewBox, stroke-based, line-cap round so they look the
// same on iOS Safari, Android Chrome and Desktop without depending on the
// system emoji font.

const PATHS = {
  // Speed / movement
  boot: '<path d="M5 4h5v9h8v4H10l-2 2H5z" /><path d="M10 13l2 2"/>',
  // Defense / shield (also used for Орб-щит)
  shield: '<path d="M12 3 4 6v6c0 4 3 7 8 9 5-2 8-5 8-9V6z"/>',
  // Regeneration / healing necklace
  gem: '<path d="M5 9l3-5h8l3 5-7 11z"/><path d="M5 9h14M9 4l3 5 3-5"/>',
  // Poison fang / snake
  snake: '<path d="M5 8c4-4 8 4 14 0"/><path d="M16 12l3 2-2 3"/><path d="M11 9v3"/>',
  // Echo bow & arrow
  bow: '<path d="M6 4c5 5 5 11 0 16"/><path d="M6 4l13 8-13 8"/><path d="M2 12h17"/>',
  // Flame (rage / fireball)
  flame: '<path d="M12 3c-3 4-5 7-5 11a5 5 0 0 0 10 0c0-3-2-5-2-7 0 2-1 3-3 1 0-2-.0-4 0-5z"/>',
  // Crit hammer
  hammer: '<path d="M14 4h7v5h-7z"/><path d="M14 6L4 16l3 3 10-10"/>',
  // Lifesteal blood drop
  drop: '<path d="M12 3c-4 6-7 10-7 13a7 7 0 0 0 14 0c0-3-3-7-7-13z"/>',
  // Lightning (doubleStrike)
  bolt: '<path d="M13 2 4 14h7v8l9-12h-7z"/>',
  // Dash explosion / starburst
  burst: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M5 19l4-4"/><circle cx="12" cy="12" r="2"/>',
  // Snowflake (frost / icebolt)
  snowflake: '<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/><path d="M9 4l3 3 3-3M9 20l3-3 3 3M4 9l3 3-3 3M20 9l-3 3 3 3"/>',
  // Wind (dodge / windpush)
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h8"/>',
  // Trident (thunder)
  trident: '<path d="M5 4v5a7 7 0 0 0 14 0V4"/><path d="M12 4v17M9 4v5M15 4v5"/>',
  // Handshake (companion)
  handshake: '<path d="M3 14l5-5 4 4 4-4 5 5-3 3-4-3-2 1-2-1-4 3z"/>',
  // Heart (bond / regenAura)
  heart: '<path d="M12 21C5 15 4 9 8 7c2-1 4 1 4 3 0-2 2-4 4-3 4 2 3 8-4 14z"/>',
  // Clock (slowtime)
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  // Skull / berserk anger face
  skull: '<path d="M5 11a7 7 0 0 1 14 0v6h-3v3h-2v-3h-2v3h-2v-3H8v3H6v-3H5z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  // Coin (gold / upgrades)
  coin: '<circle cx="12" cy="12" r="9"/><path d="M9 9h6M9 12h6M9 15h6"/>',
  // Sparkle / generic / fallback
  sparkle: '<path d="M12 3l1.5 7L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z"/>',
  // Dot (empty slot)
  dot: '<circle cx="12" cy="12" r="2"/>',
  // Pickaxe / dig — extra
  pickaxe: '<path d="M14 3l7 7-3 3-3-3-9 9-3-3 9-9-3-3z"/>',
  // Sword (attack / damage)
  sword: '<path d="M14 4h6v6"/><path d="M20 4L9 15"/><path d="M5 19l-2-2 4-4 4 4-4 4z"/><path d="M8 16l4 4"/>',
  // Hand (interact)
  hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v5"/><path d="M10 11V4a1.5 1.5 0 0 1 3 0v7"/><path d="M13 11V5a1.5 1.5 0 0 1 3 0v6"/><path d="M16 11V7a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-2a7 7 0 0 1-7-7v-3l3 1"/>',
};

// Render an SVG icon as a string. Use {size} to set width/height in px,
// {color} to override currentColor, and {className} to attach a CSS class
// (e.g. for inline-block alignment). The svg is returned as a single
// trimmed string so it slots into innerHTML or template literals.
export function iconSvg(id, opts = {}) {
  const path = PATHS[id] || PATHS.sparkle;
  const size = opts.size || 16;
  const color = opts.color || 'currentColor';
  const cls = opts.className ? ` class="${opts.className}"` : '';
  const stroke = opts.strokeWidth || 2;
  const style = opts.inline === false ? '' : ' style="vertical-align:middle"';
  return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${style}>${path}</svg>`;
}

// Convenience wrapper: returns SVG markup for an icon id, fallback to
// sparkle when missing. Used everywhere a UI cell wants to display an
// item / ability / upgrade icon as a small inline glyph.
export function iconHTML(id, opts) {
  return iconSvg(id || 'sparkle', opts);
}

export const ICON_IDS = Object.keys(PATHS);
