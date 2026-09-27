/**
 * Profile state management, persistence (localStorage), and active camp tracking.
 */
import { DEFAULT_PROFILE } from "./constants.js";

const STORAGE_KEY = "mapprof";
const DEBUG_KEY = "mapdebug";

const safeStorage = {
  get: (k, fallback = null) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(k) : fallback;
    } catch {
      return fallback;
    }
  },
  set: (k, v) => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
    } catch {}
  }
};

// Load persisted profiles from localStorage or fall back to defaults
function loadProfiles() {
  let stored = {};
  try {
    const raw = safeStorage.get(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn("Failed to parse stored profile, using defaults", e);
  }
  return {
    blue: Object.assign({}, DEFAULT_PROFILE, stored.blue),
    red: Object.assign({}, DEFAULT_PROFILE, stored.red)
  };
}

export const state = {
  profiles: loadProfiles(),
  selfCamp: 1, // 1 = blue, 2 = red
  showGrid: true,
  debugMode: safeStorage.get(DEBUG_KEY) === "1",
  draftSig: "",
  frames: 0,
  fps: 0,
  fpsTimer: performance.now(),
  connected: false,
  lastPingMs: 0,
  lastData: null
};

// Returns the active side profile (blue or red)
export function getActiveProfile() {
  return state.selfCamp === 2 ? state.profiles.red : state.profiles.blue;
}

export function getProfileName() {
  return state.selfCamp === 2 ? "red" : "blue";
}

export function saveProfiles() {
  safeStorage.set(STORAGE_KEY, JSON.stringify(state.profiles));
}

export function resetActiveProfile() {
  const key = state.selfCamp === 2 ? "red" : "blue";
  state.profiles[key] = Object.assign({}, DEFAULT_PROFILE);
  saveProfiles();
}

export function setDebugMode(enabled) {
  state.debugMode = enabled;
  safeStorage.set(DEBUG_KEY, enabled ? "1" : "0");
}
