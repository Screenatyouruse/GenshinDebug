/**
 * Coordinate transformations between 3D in-game world coordinates and 2D canvas screen pixels.
 */
import { WC, WS, W_SPAN } from "./constants.js";
import { state, getActiveProfile } from "./state.js";

/**
 * Normalizes world X and Z coordinates according to the map projection angle and span.
 */
export function worldNorm(x, z) {
  const zz = -z;
  return [
    (WC * x - WS * zz) / W_SPAN,
    (WS * x + WC * zz) / W_SPAN
  ];
}

/**
 * Returns whether coordinates and map should be inverted 180°.
 * Automatically normalizes Red side (selfCamp === 2) so player base is at bottom-left ("blue side").
 */
export function isFlipped() {
  const p = getActiveProfile();
  return state.selfCamp === 2 ? !p.flip : !!p.flip;
}

/**
 * Converts world X and Z coordinates to screen canvas pixel coordinates.
 * Supports arbitrary canvas dimensions (defaults to CX/CY center).
 */
export function worldToScreen(x, z, cx = 360, cy = 360) {
  let [nx, ny] = worldNorm(x, z);
  const p = getActiveProfile();

  if (isFlipped()) {
    nx = -nx;
    ny = -ny;
  }

  const rad = (p.rot * Math.PI) / 180;
  const rx = nx * Math.cos(rad) - ny * Math.sin(rad);
  const ry = nx * Math.sin(rad) + ny * Math.cos(rad);

  return [
    cx + p.ox + rx * p.scale,
    cy + p.oy + ry * p.scale
  ];
}

/**
 * Normalized base positions for the current active camp.
 */
export function getBaseAnchors() {
  const myBaseWorld = worldNorm(state.selfCamp === 2 ? 51 : -51, 0);
  const enBaseWorld = worldNorm(state.selfCamp === 2 ? -51 : 51, 0);

  const applyFlip = v => isFlipped() ? [-v[0], -v[1]] : v;
  return [applyFlip(myBaseWorld), applyFlip(enBaseWorld)];
}

/**
 * Calibrates scale, rotation, and offsets based on user clicking their base then enemy base.
 */
export function calibrateProfile(pt1, pt2, cx = 360, cy = 360) {
  const p = getActiveProfile();
  const [A_MY, A_EN] = getBaseAnchors();

  const d = [pt2[0] - pt1[0], pt2[1] - pt1[1]];
  const da = [A_EN[0] - A_MY[0], A_EN[1] - A_MY[1]];

  p.scale = Math.hypot(d[0], d[1]) / Math.hypot(da[0], da[1]);

  let rotDeg = ((Math.atan2(d[1], d[0]) - Math.atan2(da[1], da[0])) * 180) / Math.PI;
  if (rotDeg > 180) rotDeg -= 360;
  if (rotDeg < -180) rotDeg += 360;
  p.rot = rotDeg;

  const rad = (p.rot * Math.PI) / 180;
  const rx = (A_MY[0] * Math.cos(rad) - A_MY[1] * Math.sin(rad)) * p.scale;
  const ry = (A_MY[0] * Math.sin(rad) + A_MY[1] * Math.cos(rad)) * p.scale;

  p.ox = pt1[0] - cx - rx;
  p.oy = pt1[1] - cy - ry;

  return p;
}
