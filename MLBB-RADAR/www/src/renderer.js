/**
 * Canvas rendering pipeline: map image, grid lines, heroes, health bars, cooldown pips, and jungle creeps.
 */
import { HEROES, CREEPS, getHeroName } from "./constants.js";
import { state, getActiveProfile } from "./state.js";
import { worldToScreen, isFlipped } from "./coords.js";

// Hero icon cache
const iconCache = new Map();

export function getHeroIcon(id) {
  if (iconCache.has(id)) return iconCache.get(id);

  const img = new Image();
  const fileId = id + 1; // MLBB asset file indexing offset
  img.src = `mlbbicons/${fileId}.png`;

  img.onload = () => { iconCache.set(id, img); };
  img.onerror = () => { iconCache.set(id, null); };

  iconCache.set(id, false); // Pending load
  return false;
}

// Background map state
let imgBlue = null;
let imgRed = null;
let imgW = 0;
let imgH = 0;
let imgFit = 1;

export function loadMapImage(url, isRed = false, cb = null) {
  const img = new Image();
  img.onload = () => {
    if (isRed) {
      imgRed = img;
    } else {
      imgBlue = img;
      imgW = img.width;
      imgH = img.height;
    }
    if (cb) cb(img);
  };
  img.src = url + "?" + Math.random();
}

export function setCustomMapImage(file, isRed) {
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      if (isRed) {
        imgRed = img;
      } else {
        imgBlue = img;
      }
      imgW = img.width;
      imgH = img.height;
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// Initialize default map images
loadMapImage("map.png", false);
loadMapImage("map_red.png", true);

export function hpColor(hp, hm) {
  const r = hm ? hp / hm : 0;
  return r > 0.6 ? "#66bb6a" : r > 0.3 ? "#ffee58" : "#ef5350";
}

/**
 * Clears canvas and renders the background map and tactical grid.
 */
export function drawScene(cv, ctx) {
  const cx = cv.width / 2;
  const cy = cv.height / 2;

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#0d1420";
  ctx.fillRect(0, 0, cv.width, cv.height);

  const redView = state.selfCamp === 2;
  const img = redView ? (imgRed || imgBlue) : imgBlue;

  if (imgW > 0 && imgH > 0) {
    imgFit = Math.min(cv.width / imgW, cv.height / imgH, 1);
  }

  if (img) {
    const w = (imgW || cv.width) * imgFit;
    const h = (imgH || cv.height) * imgFit;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.strokeStyle = "#263238";
    ctx.strokeRect(cx - 350, cy - 350, 700, 700);
  }

  if (state.showGrid) {
    ctx.strokeStyle = "rgba(120, 144, 156, 0.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo((i * cv.width) / 10, 0);
      ctx.lineTo((i * cv.width) / 10, cv.height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, (i * cv.height) / 10);
      ctx.lineTo(cv.width, (i * cv.height) / 10);
      ctx.stroke();
    }
  }
}

/**
 * Renders a hero avatar, HP bar, cooldown pips, and nameplate.
 */
export function drawHero(ctx, cv, e, isSelf) {
  const cx = cv.width / 2;
  const cy = cv.height / 2;
  const [mx, my] = worldToScreen(e.p[0], e.p[2], cx, cy);

  const p = getActiveProfile();
  const color = isSelf ? "#42a5f5" : e.ally ? "#66bb6a" : "#ef5350";
  const baseR = p.iconsize || 14;
  const r = isSelf ? baseR + 2 : baseR;
  const skScale = p.skscale || 1.0;

  // Fog alert indicator ring for unseen enemy
  if (e.fog && !e.ally && !isSelf) {
    ctx.beginPath();
    ctx.arc(mx, my, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffb74d";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Draw Avatar or Fallback Dot
  const icon = getHeroIcon(e.id);
  if (icon && icon.complete && icon.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.clip();

    const iw = icon.naturalWidth;
    const ih = icon.naturalHeight;
    const cropDim = Math.min(iw, ih);
    const sx = (iw - cropDim) / 2;
    const sy = (ih - cropDim) / 2;

    ctx.globalAlpha = (e.fog && !e.ally && !isSelf) ? 0.95 : 1.0;
    ctx.drawImage(icon, sx, sy, cropDim, cropDim, mx - r, my - r, r * 2, r * 2);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, r * 0.15);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = (e.fog && !e.ally && !isSelf) ? 0.95 : 0.8;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#eceff1";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Health & Mana Bar above avatar
  if (e.hm > 0) {
    const w = Math.max(30, r * 2.2);
    const hx = mx - w / 2;
    const hy = my - r - 10;
    // HP Bar
    ctx.fillStyle = "#101820";
    ctx.fillRect(hx - 1, hy - 1, w + 2, 5);
    ctx.fillStyle = hpColor(e.hp, e.hm);
    ctx.fillRect(hx, hy, w * Math.max(0, e.hp / e.hm), 3);

    // Mana / Energy Bar
    if (e.mm > 0) {
      const my_mana = hy + 4;
      ctx.fillStyle = "#101820";
      ctx.fillRect(hx - 1, my_mana - 1, w + 2, 3);
      // Blue for mana, bright yellow for energy (e.g. Fanny/Nolan mm <= 200)
      ctx.fillStyle = e.mm <= 200 ? "#ffca28" : "#29b6f6";
      ctx.fillRect(hx, my_mana, w * Math.max(0, e.mp / e.mm), 2);
    }

    // Action Badge (Recall, Skill, Dead)
    const anim = (typeof e.an === 'string') ? e.an.toLowerCase() : "";
    let badgeText = null;
    let badgeColor = "#ffb74d";
    if (anim.includes("home") || anim.includes("recall") || anim.includes("teleport")) {
      badgeText = "RECALL";
      badgeColor = "#42a5f5";
    } else if (anim.includes("dead")) {
      badgeText = "DEAD";
      badgeColor = "#78909c";
    } else if (anim.includes("skill") || anim.includes("attack")) {
      badgeText = anim.toUpperCase();
      badgeColor = "#ff7043";
    }

    if (badgeText) {
      ctx.font = "bold 8px Consolas, monospace";
      const tw = ctx.measureText(badgeText).width + 6;
      ctx.fillStyle = "#0b0f14";
      ctx.strokeStyle = badgeColor;
      ctx.lineWidth = 1;
      ctx.fillRect(mx - tw / 2, hy - 11, tw, 10);
      ctx.strokeRect(mx - tw / 2, hy - 11, tw, 10);
      ctx.fillStyle = badgeColor;
      ctx.textAlign = "center";
      ctx.fillText(badgeText, mx, hy - 3);
    }
  }

  // Skill indicators & Cooldowns
  let pipBottomY = my + r + 14;
  if (e.sk) {
    const baseW = 9;
    const baseH = 8;
    const baseGap = 2;
    const pw = baseW * skScale;
    const ph = baseH * skScale;
    const gap = baseGap * skScale;
    const fontSize = Math.max(7, Math.round(8 * skScale));
    const n = 5;
    const totalW = n * pw + (n - 1) * gap;

    const px0 = mx - totalW / 2;
    const py = my + r + 5;

    // Skills 1 to 4
    for (let i = 0; i < 4; i++) {
      const v = e.sk[i];
      const curX = px0 + i * (pw + gap);
      ctx.fillStyle = v < 0 ? "#1a2530" : v > 0 ? "#3e2723" : "#1b4d2a";
      ctx.fillRect(curX, py, pw, ph);
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 1;
      ctx.strokeRect(curX, py, pw, ph);
      if (v > 0) {
        ctx.fillStyle = "#ffb74d";
        ctx.font = `${fontSize}px Consolas`;
        ctx.textAlign = "center";
        ctx.fillText(v > 99 ? "99" : String(v), curX + pw / 2, py + ph - ph * 0.15);
      }
    }

    // Battle Spell (index 4)
    const sx = px0 + 4 * (pw + gap);
    ctx.fillStyle = e.sp < 0 ? "#1a2530" : e.sp > 0 ? "#0d2b3e" : "#0d3a4d";
    ctx.fillRect(sx, py, pw, ph);
    ctx.strokeStyle = "#0b0f14";
    ctx.strokeRect(sx, py, pw, ph);
    if (e.sp > 0) {
      ctx.fillStyle = "#4db6ac";
      ctx.font = `${fontSize}px Consolas`;
      ctx.textAlign = "center";
      ctx.fillText(e.sp > 99 ? "99" : String(e.sp), sx + pw / 2, py + ph - ph * 0.15);
    }
    pipBottomY = py + ph;
  }

  // Name Label
  ctx.fillStyle = "#eceff1";
  ctx.font = "10px Consolas";
  ctx.textAlign = "center";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 3;

  const heroName = getHeroName(e);
  let label = heroName + (e.fog && !e.ally && !isSelf ? " *" : "");

  if (state.debugMode) label += " #" + e.id;
  ctx.fillText(label, mx, pipBottomY + 11);
  ctx.shadowBlur = 0;
}

/**
 * Renders jungle monsters, objectives (Lord/Turtle), and minions.
 */
export function drawJungle(ctx, cv, m) {
  if (Math.abs(m.p[0]) < 0.01 && Math.abs(m.p[2]) < 0.01) return;
  if (m.id === 2093 || m.id === 2094 || m.id === 2084) return;

  const cx = cv.width / 2;
  const cy = cv.height / 2;

  // Minions / Turret / Siege entities
  if (m.id >= 1000 && m.id < 1200) {
    if (m.death) return;
    if ((m.hm || 0) >= 3000) {
      if (state.debugMode) {
        const [tx, ty] = worldToScreen(m.p[0], m.p[2], cx, cy);
        ctx.fillStyle = "#78909c";
        ctx.font = "8px Consolas";
        ctx.textAlign = "center";
        ctx.fillText("#" + m.id, tx, ty - 10);
      }
      return;
    }
    const [mx, my] = worldToScreen(m.p[0], m.p[2], cx, cy);
    ctx.beginPath();
    ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffca28";
    ctx.fill();
    ctx.strokeStyle = "#0b0f14";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (state.debugMode) {
      ctx.fillStyle = "#ffcc80";
      ctx.font = "8px Consolas";
      ctx.textAlign = "center";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 2;
      ctx.fillText("#" + m.id, mx, my + 13);
      ctx.shadowBlur = 0;
    }
    return;
  }

  if (m.death) return;

  const creep = CREEPS[m.id];
  const buff = !creep && m.id >= 2080 && m.id < 2200;

  if (!creep && !buff) {
    if (state.debugMode) {
      const [dx, dy] = worldToScreen(m.p[0], m.p[2], cx, cy);
      ctx.fillStyle = "#9e9e9e";
      ctx.font = "8px Consolas";
      ctx.textAlign = "center";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 2;
      ctx.fillText("?" + m.id, dx, dy);
      ctx.shadowBlur = 0;
    }
    return;
  }

  const [mx, my] = worldToScreen(m.p[0], m.p[2], cx, cy);
  ctx.beginPath();
  ctx.arc(mx, my, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#4caf50";
  ctx.fill();
  ctx.strokeStyle = "#0b0f14";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (m.hm > 0) {
    const w = 24;
    const hx = mx - w / 2;
    const hy = my - 12;
    ctx.fillStyle = "#263238";
    ctx.fillRect(hx - 1, hy - 1, w + 2, 4);
    ctx.fillStyle = hpColor(m.hp, m.hm);
    ctx.fillRect(hx, hy, w * Math.max(0, m.hp / m.hm), 2);
  }

  if (creep || state.debugMode) {
    ctx.fillStyle = "#a5d6a7";
    ctx.font = "9px Consolas";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3;
    let label = creep || "";
    if (state.debugMode) label += (label ? " #" : "#") + m.id;
    ctx.fillText(label, mx, my + 16);
    ctx.shadowBlur = 0;
  }
}
