/**
 * Game constants, lookup tables, and default profile settings.
 */

export const DEFAULT_PROFILE = {
  scale: 725.21,
  rot: 0.9,
  ox: -3,
  oy: 1,
  skscale: 1.8,
  iconsize: 21,
  flip: false
};

// Coordinate system constants
export const W_ANGLE_DEG = 314.60;
export const W_ANGLE = (W_ANGLE_DEG * Math.PI) / 180;
export const W_SPAN = 74.11;
export const WC = Math.cos(W_ANGLE);
export const WS = Math.sin(W_ANGLE);

// Jungle creep ID to display name mapping
export const CREEPS = {
  2002: "Lord",
  2003: "Turtle",
  2004: "Fiend",
  2005: "Serpent",
  2006: "Scaled Lizard",
  2008: "Crammer",
  2009: "Rockursa",
  2011: "Crab",
  2012: "Serpent Kids",
  2013: "Crab",
  2056: "Lithowanderer",
  2059: "Crammer",
  2072: "Lithowanderer",
  2110: "Turtle"
};

// Lane / road assignments
export const ROAD = {
  1: "EXP",
  2: "GOLD",
  3: "MID",
  4: "ROAM",
  5: "JUNGLE"
};

// Hero ID to hero name mapping
export const HEROES = {
  1: "Miya", 2: "Balmond", 3: "Saber", 4: "Alice", 5: "Nana", 6: "Tigreal", 7: "Alucard",
  8: "Karina", 9: "Akai", 10: "Franco", 11: "Bane", 12: "Bruno", 13: "Clint", 14: "Rafaela",
  15: "Eudora", 16: "Zilong", 17: "Fanny", 18: "Layla", 19: "Minotaur", 20: "Lolita",
  21: "Hayabusa", 22: "Freya", 23: "Gord", 24: "Natalia", 25: "Kagura", 26: "Chou",
  27: "Sun", 28: "Alpha", 29: "Ruby", 30: "Yi Sun-shin", 31: "Moskov", 32: "Johnson",
  33: "Cyclops", 34: "Estes", 35: "Hilda", 36: "Aurora", 37: "Lapu-Lapu", 38: "Vexana",
  39: "Roger", 40: "Karrie", 41: "Grock", 42: "Harley", 43: "Irithel", 44: "Grock",
  45: "Argus", 46: "Odette", 47: "Lancelot", 48: "Diggie", 49: "Hylos", 50: "Zhask",
  51: "Helcurt", 52: "Pharsa", 53: "Lesley", 54: "Jawhead", 55: "Angela", 56: "Gusion",
  57: "Valir", 58: "Martis", 59: "Uranus", 60: "Hanabi", 61: "Chang'e", 62: "Kaja",
  63: "Selena", 64: "Aldous", 65: "Claude", 66: "Vale", 67: "Leomord", 68: "Lunox",
  69: "Hanzo", 70: "Belerick", 71: "Kimmy", 72: "Thamuz", 73: "Harith", 74: "Minsitthar",
  75: "Kadita", 76: "Faramis", 77: "Badang", 78: "Khufra", 79: "Granger", 80: "Guinevere",
  81: "Esmeralda", 82: "Terizla", 83: "X.Borg", 84: "Ling", 85: "Dyrroth", 86: "Lylia",
  87: "Baxia", 88: "Masha", 89: "Wanwan", 90: "Silvanna", 91: "Carmilla", 92: "Cecilion",
  93: "Atlas", 94: "Popol and Kupa", 95: "Yu Zhong", 96: "Luo Yi", 97: "Benedetta",
  98: "Khaleed", 99: "Barats", 100: "Brody", 101: "Yve", 102: "Mathilda", 103: "Paquito",
  104: "Gloo", 105: "Beatrix", 106: "Phoveus", 107: "Natan", 108: "Aulus", 109: "Aamon",
  110: "Valentina", 111: "Edith", 112: "Floryn", 113: "Yin", 114: "Melissa", 115: "Xavier",
  116: "Julian", 117: "Fredrinn", 118: "Joy", 119: "Novaria", 120: "Arlott", 121: "Ixia",
  122: "Nolan", 123: "Cici", 124: "Chip", 125: "Zhuxin", 126: "Suyou", 127: "Lukas",
  128: "Kalea"
};

/**
 * Resolves hero display name based on hero ID / icon mapping first,
 * preventing stale cached names across matches.
 *
 * @param {Object|number} heroOrId - Hero entity object or integer hero ID
 * @returns {string} Clean hero name
 */
export function getHeroName(heroOrId) {
  if (!heroOrId && heroOrId !== 0) return "Unknown";
  const id = (typeof heroOrId === "object") ? heroOrId.id : heroOrId;
  if (typeof id === "number" && HEROES[id]) {
    return HEROES[id];
  }
  if (typeof heroOrId === "object") {
    if (heroOrId.hn && typeof heroOrId.hn === "string" && heroOrId.hn.length) return heroOrId.hn;
    if (heroOrId.n && typeof heroOrId.n === "string" && heroOrId.n.length) return heroOrId.n;
    if (heroOrId.name && typeof heroOrId.name === "string" && heroOrId.name.length) return heroOrId.name;
    return (typeof id === "number" && id > 0) ? `Hero #${id}` : "Unknown";
  }
  return (typeof id === "number" && id > 0) ? `Hero #${id}` : "Unknown";
}

// Battle spell IDs (Summon Skills)
export const BATTLE_SPELLS = {
  20010: "Execute",
  20020: "Retribution",
  20030: "Inspire",
  20040: "Sprint",
  20050: "Revitalize",
  20060: "Aegis",
  20070: "Petrify",
  20080: "Purify",
  20090: "Flameshot",
  20100: "Flicker",
  20110: "Arrival",
  20120: "Vengeance"
};

/**
 * Checks if a summon skill ID is Retribution (including blessing/jungle variants).
 *
 * @param {number} sm - summon skill ID
 * @returns {boolean}
 */
export function isRetributionSpell(sm) {
  if (typeof sm !== "number") return false;
  return sm === 20020 || (sm >= 20020 && sm <= 20029);
}

/**
 * Returns human-readable battle spell name.
 *
 * @param {number} sm - summon skill ID
 * @returns {string}
 */
export function getSpellName(sm) {
  if (typeof sm !== "number" || sm < 0) return "None";
  return BATTLE_SPELLS[sm] || `Spell #${sm}`;
}

