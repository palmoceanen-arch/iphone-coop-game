// Dynamic in-world prompt labels. World interactables (chests, altars,
// runes, planters, gates, campfires) used to hard-code keyboard hints
// like "Нажми E чтобы открыть сундук". On gamepad that's not useful;
// the player needs to see the controller glyph instead.
//
// This module owns the per-slot mapping from a semantic action
// ('interact' / 'seedCycle' / 'ability') to a short label, picked
// based on which input device the slot is currently using. The active
// input kind is tracked by `Input` (input.js) — keyboard keys flip the
// slot to 'keyboard', gamepad activity flips it to 'gamepad'.

// Keyboard layout per slot. Mirrors `P1_KEYS` / `P2_KEYS` in input.js
// (kept colocated here so the prompt strings stay in lockstep with the
// playable keys — change one and the other shouts via grep).
const KB_LABELS = [
  { interact: 'E', seedCycle: 'Q', ability: 'G', confirm: 'F', dash: 'R', buildMenu: 'B', back: 'Esc' },
  { interact: 'J', seedCycle: 'U', ability: 'H', confirm: 'L', dash: 'K', buildMenu: 'N', back: 'Esc' },
];

// XInput-style face button labels (Xbox / generic). Maps the same
// semantic actions to their Xbox glyphs. `confirm` is the south face
// button, `back` is east.
const GP_XINPUT = {
  interact: 'X',
  seedCycle: 'LB',
  ability: 'RB',
  confirm: 'A',
  back: 'B',
  dash: 'B',
  buildMenu: 'Y',
};

// Nintendo Pro / Switch face labels — same physical positions but
// labelled differently (A/B and X/Y are swapped vs. XInput).
const GP_NINTENDO = {
  interact: 'Y',
  seedCycle: 'L',
  ability: 'R',
  confirm: 'B',
  back: 'A',
  dash: 'A',
  buildMenu: 'X',
};

// Active Input reference, wired by Game on construction. Optional so
// unit tests / standalone tooling can import this module without a
// running input layer (the fallback returns keyboard labels).
let _input = null;

export function bindInput(input) {
  _input = input;
}

function _kind(slot) {
  if (!_input) return 'keyboard';
  return _input.lastInputKind(slot);
}

function _nintendo(slot) {
  if (!_input) return false;
  return _input.isNintendoSlot(slot);
}

// Returns the short label for `action` on player `slot` (0 or 1) based
// on the currently-active input device. Unknown actions fall through
// to the action name itself so callers see something readable in dev.
export function promptLabelFor(slot, action) {
  const slotIdx = slot === 1 ? 1 : 0;
  if (_kind(slotIdx) === 'gamepad') {
    const map = _nintendo(slotIdx) ? GP_NINTENDO : GP_XINPUT;
    return map[action] || action;
  }
  return KB_LABELS[slotIdx][action] || action;
}

// Render a complete "Нажми X чтобы Y" prompt with the right glyph for
// the active input. The keyboard version reads as plain text ("Нажми E
// чтобы…"); the gamepad version wraps the glyph in parentheses ("Нажми
// (A) чтобы…") so it visually pops out from the surrounding Russian
// text.
export function pressPromptText(slot, action, verbPhrase) {
  const slotIdx = slot === 1 ? 1 : 0;
  const label = promptLabelFor(slotIdx, action);
  if (_kind(slotIdx) === 'gamepad') return `Нажми (${label}) ${verbPhrase}`;
  return `Нажми ${label} ${verbPhrase}`;
}
