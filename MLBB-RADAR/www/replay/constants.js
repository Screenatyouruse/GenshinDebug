"use strict";

const $ = id => document.getElementById(id);

// ---------------- Creeps & Heroes Dict ----------------
const CREEPS = {
  2002: "Lord", 2003: "Turtle", 2004: "Fiend", 2005: "Serpent", 2006: "Scaled Lizard",
  2008: "Crammer", 2009: "Rockursa", 2011: "Crab", 2012: "Serpent Kids", 2013: "Crab",
  2056: "Lithowanderer", 2059: "Crammer", 2072: "Lithowanderer", 2110: "Turtle"
};

const HEROES = {
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

// Hero icon loader
const iconCache = {};
function getHeroIcon(id) {
  if (iconCache[id] !== undefined) return iconCache[id];
  const img = new Image();
  img.src = `mlbbicons/${id + 1}.png`;
  img.onload = () => { iconCache[id] = img; };
  img.onerror = () => { iconCache[id] = null; };
  iconCache[id] = false;
  return false;
}

// Map images
let imgBlue = null, imgRed = null, imgW = 0, imgH = 0, imgFit = 1;
function loadImg(url, cb) {
  const im = new Image();
  im.onload = () => cb(im);
  im.src = url;
}

function initMapImages(canvas) {
  loadImg("map.png", im => {
    if (!imgBlue) {
      imgBlue = im;
      imgW = im.width;
      imgH = im.height;
      imgFit = Math.min(canvas.width / imgW, canvas.height / imgH, 1);
    }
  });
  loadImg("map_red.png", im => { imgRed = im; });
}

function hpColor(hp, hm) {
  const r = hm ? hp / hm : 0;
  return r > 0.6 ? "#66bb6a" : r > 0.3 ? "#ffee58" : "#ef5350";
}
