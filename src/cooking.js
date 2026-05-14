// Cooking system — transforms raw harvested crops into cooked dishes
// with healing + temporary buffs.
//
// Phase 1: campfire recipes (single-ingredient).
// Phase 2 (future): cauldron recipes (multi-ingredient combos).
//
// The player stands near a campfire (player-built or altar bonfire),
// cycles through available recipes with Q, then holds E for COOK_HOLD_S
// seconds to cook. The cooked dish is added to player.cookedFoods and
// can be consumed later with a long Q press (0.4s) when away from any
// interactable.

// Cook hold duration in seconds — mirrors the revive-bar UX.
export const COOK_HOLD_S = 5.0;

// Long-press threshold for eating food via Q (seconds).
export const EAT_HOLD_S = 0.4;

// Interaction radius for campfire cooking. Slightly larger than the
// campfire collision radius (0.40) so the player can stand next to the
// fire without being pushed out.
export const COOK_INTERACT_RADIUS = 1.6;

// Buff types applied by cooked dishes. Each recipe specifies one buff
// entry; the player's update() tick decrements the TTL and the relevant
// combat/movement code reads the active buff.
//
// Buff shape: { kind, value, ttl }
//   kind: 'atkSpeed' | 'speed' | 'damage' | 'armor'
//   value: multiplier or flat bonus depending on kind
//   ttl: remaining seconds

// Single-ingredient campfire recipes.
// `cost`: { cropKind: amount }
// `heal`: flat HP restored on eat
// `buff`: { kind, value, ttl } — temporary buff applied on eat
export const RECIPES = {
  bread: {
    id: 'bread',
    name: 'Хлеб',
    cost: { wheat: 2 },
    heal: 60,
    buff: { kind: 'atkSpeed', value: 0.15, ttl: 12 },
  },
  roasted_carrot: {
    id: 'roasted_carrot',
    name: 'Жареная морковь',
    cost: { carrot: 3 },
    heal: 35,
    buff: { kind: 'speed', value: 1.0, ttl: 12 },
  },
  baked_pumpkin: {
    id: 'baked_pumpkin',
    name: 'Запечёная тыква',
    cost: { pumpkin: 4 },
    heal: 90,
    buff: { kind: 'damage', value: 0.25, ttl: 10 },
  },
  stewed_cabbage: {
    id: 'stewed_cabbage',
    name: 'Тушёная капуста',
    cost: { cabbage: 3 },
    heal: 40,
    buff: { kind: 'armor', value: 0.30, ttl: 14 },
  },
};

// Stable iteration order for recipe cycling.
export const RECIPE_ORDER = ['bread', 'roasted_carrot', 'baked_pumpkin', 'stewed_cabbage'];

// Raw crop heal values — eating a raw crop without cooking.
export const RAW_HEAL = {
  wheat: 15,
  carrot: 10,
  pumpkin: 25,
  cabbage: 18,
};

// Check whether a player can afford a recipe.
export function canCook(foods, recipeId) {
  const recipe = RECIPES[recipeId];
  if (!recipe) return false;
  for (const [crop, needed] of Object.entries(recipe.cost)) {
    if ((foods[crop] || 0) < needed) return false;
  }
  return true;
}

// Execute a cook: deduct ingredients from `foods`, return the recipe id.
// Caller is responsible for adding the dish to player.cookedFoods.
// Returns null if ingredients are insufficient.
export function cook(foods, recipeId) {
  if (!canCook(foods, recipeId)) return null;
  const recipe = RECIPES[recipeId];
  for (const [crop, needed] of Object.entries(recipe.cost)) {
    foods[crop] -= needed;
    if (foods[crop] <= 0) delete foods[crop];
  }
  return recipeId;
}

// Human-readable cost string for a recipe (used in prompts).
export function recipeCostLabel(recipeId) {
  const recipe = RECIPES[recipeId];
  if (!recipe) return '';
  return Object.entries(recipe.cost)
    .map(([crop, n]) => `${n}x ${cropNameRu(crop)}`)
    .join(', ');
}

// Buff description for toast display.
export function buffLabel(buff) {
  if (!buff) return '';
  switch (buff.kind) {
    case 'atkSpeed': return `+${Math.round(buff.value * 100)}% скор. атаки`;
    case 'speed':    return `+${buff.value} скорость`;
    case 'damage':   return `+${Math.round(buff.value * 100)}% урон`;
    case 'armor':    return `-${Math.round(buff.value * 100)}% получ. урон`;
    default:         return '';
  }
}

function cropNameRu(kind) {
  const names = { wheat: 'пшен.', carrot: 'морк.', pumpkin: 'тыкв.', cabbage: 'капуст.' };
  return names[kind] || kind;
}
