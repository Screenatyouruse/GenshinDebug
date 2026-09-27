"use strict";

// ---------------- Minimap & Entity Renderer ----------------
let cv = null;
let ctx = null;
let visionMode = "oracle"; // 'oracle' (all shown) vs 'fog' (fogged enemies ghosted)

function initRenderer(canvasElement) {
  cv = canvasElement || $("map");
  if (cv) {
    ctx = cv.getContext("2d");
    initMapImages(cv);
  }
}

function drawScene() {
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#0d1420";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const redView = selfCamp === 2;
  const im = redView ? (imgRed || imgBlue) : imgBlue;
  if (im) {
    const w = imgW * imgFit, h = imgH * imgFit;
    ctx.drawImage(im, CX - w / 2, CY - h / 2, w, h);
  } else {
    ctx.strokeStyle = "#263238";
    ctx.strokeRect(CX - 350, CY - 350, 700, 700);
  }
}

function drawEntity(e, isSelf) {
  if (!ctx) return;
  const isEnemyFogged = e.fog && !e.ally && !isSelf;

  // In Player Vision (Fog ON), dim hidden enemies to 15% ghost silhouette
  if (visionMode === "fog" && isEnemyFogged) {
    ctx.save();
    ctx.globalAlpha = 0.15;
  }

  const px = e.p[0];
  const pz = e.p.length > 2 ? e.p[2] : e.p[1];
  const [mx, my] = worldToScreen(px, pz);
  const color = isSelf ? "#42a5f5" : e.ally ? "#66bb6a" : "#ef5350";
  const baseR = active().iconsize || 21;
  const r = isSelf ? baseR + 2 : baseR;
  const skScale = active().skscale || 1.8;

  // Fog alert ring
  if (isEnemyFogged && visionMode === "oracle") {
    ctx.beginPath();
    ctx.arc(mx, my, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffb74d";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  const icon = getHeroIcon(e.id);
  if (icon && icon.complete && icon.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.clip();
    const iw = icon.naturalWidth, ih = icon.naturalHeight;
    const cropDim = Math.min(iw, ih);
    ctx.drawImage(icon, (iw - cropDim) / 2, (ih - cropDim) / 2, cropDim, cropDim, mx - r, my - r, r * 2, r * 2);
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
    ctx.fill();
    ctx.strokeStyle = "#eceff1";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Health Bar
  if (e.hm > 0) {
    const w = Math.max(30, r * 2.2);
    const hx = mx - w / 2, hy = my - r - 8;
    ctx.fillStyle = "#263238";
    ctx.fillRect(hx - 1, hy - 1, w + 2, 5);
    ctx.fillStyle = hpColor(e.hp, e.hm);
    ctx.fillRect(hx, hy, w * Math.max(0, e.hp / e.hm), 3);
  }

  // Skill indicators
  let pipBottomY = my + r + 14;
  if (e.sk) {
    const pw = 9 * skScale, ph = 8 * skScale, gap = 2 * skScale;
    const fontSize = Math.max(7, Math.round(8 * skScale));
    const totalW = 5 * pw + 4 * gap;
    let px0 = mx - totalW / 2;
    let py = my + r + 5;

    for (let i = 0; i < 4; i++) {
      const v = e.sk[i];
      const curX = px0 + i * (pw + gap);
      ctx.fillStyle = v < 0 ? "#1a2530" : v > 0 ? "#3e2723" : "#1b4d2a";
      ctx.fillRect(curX, py, pw, ph);
      ctx.strokeStyle = "#0b0f14";
      ctx.strokeRect(curX, py, pw, ph);
      if (v > 0) {
        ctx.fillStyle = "#ffb74d";
        ctx.font = `${fontSize}px Consolas`;
        ctx.textAlign = "center";
        ctx.fillText(v > 99 ? "99" : String(v), curX + pw / 2, py + ph - (ph * 0.15));
      }
    }

    const sx = px0 + 4 * (pw + gap);
    ctx.fillStyle = e.sp < 0 ? "#1a2530" : e.sp > 0 ? "#0d2b3e" : "#0d3a4d";
    ctx.fillRect(sx, py, pw, ph);
    ctx.strokeStyle = "#0b0f14";
    ctx.strokeRect(sx, py, pw, ph);
    if (e.sp > 0) {
      ctx.fillStyle = "#4db6ac";
      ctx.font = `${fontSize}px Consolas`;
      ctx.textAlign = "center";
      ctx.fillText(e.sp > 99 ? "99" : String(e.sp), sx + pw / 2, py + ph - (ph * 0.15));
    }
    pipBottomY = py + ph;
  }

  // Name Label
  ctx.fillStyle = "#eceff1";
  ctx.font = "10px Consolas";
  ctx.textAlign = "center";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 3;
  const heroName = (e.hn && e.hn.length) ? e.hn : (HEROES[e.id] || ("id" + e.id));
  ctx.fillText(heroName, mx, pipBottomY + 11);
  ctx.shadowBlur = 0;

  if (visionMode === "fog" && isEnemyFogged) {
    ctx.restore();
  }
}

function drawJungle(m) {
  if (!ctx) return;
  const mx0 = m.p[0];
  const mz0 = m.p.length > 2 ? m.p[2] : m.p[1];
  if (Math.abs(mx0) < 0.01 && Math.abs(mz0) < 0.01) return;
  if (m.id === 2093 || m.id === 2094 || m.id === 2084 || m.death) return;

  const dotR = active().dotsize !== undefined ? active().dotsize : 6;
  const [mx, my] = worldToScreen(mx0, mz0);

  // Minion check
  if (m.id >= 100 && m.id < 2000) {
    if ((m.hm || 0) >= 3000) return;
    const minionR = Math.max(2.5, dotR * 0.65);
    ctx.beginPath();
    ctx.arc(mx, my, minionR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffca28";
    ctx.fill();
    ctx.strokeStyle = "#0b0f14";
    ctx.stroke();
    return;
  }

  const creep = CREEPS[m.id];
  const buff = !creep && m.id >= 2080 && m.id < 2200;
  if (!creep && !buff) return;

  ctx.beginPath();
  ctx.arc(mx, my, dotR, 0, Math.PI * 2);
  ctx.fillStyle = "#4caf50";
  ctx.fill();
  ctx.strokeStyle = "#0b0f14";
  ctx.lineWidth = Math.max(1, dotR * 0.18);
  ctx.stroke();

  if (m.hm > 0) {
    const w = Math.max(24, dotR * 3.5), hx = mx - w / 2, hy = my - dotR - 7;
    ctx.fillStyle = "#263238"; ctx.fillRect(hx - 1, hy - 1, w + 2, 4);
    ctx.fillStyle = hpColor(m.hp, m.hm); ctx.fillRect(hx, hy, w * Math.max(0, m.hp / m.hm), 2);
  }

  if (creep) {
    ctx.fillStyle = "#a5d6a7";
    ctx.font = "9px Consolas";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3;
    ctx.fillText(creep, mx, my + dotR + 11);
    ctx.shadowBlur = 0;
  }
}

// ---------------- Roster Rendering ----------------
function renderRoster(list) {
  const allyDiv = $("roster-ally"), enemyDiv = $("roster-enemy");
  if (!allyDiv || !enemyDiv) return;
  allyDiv.innerHTML = ""; enemyDiv.innerHTML = "";

  if (!list || !list.length) {
    allyDiv.innerHTML = "<div style='color:#546e7a'>No data</div>";
    enemyDiv.innerHTML = "<div style='color:#546e7a'>No data</div>";
    return;
  }

  list.forEach(p => {
    const isAlly = p.camp === 1 || p.ally;
    const heroName = HEROES[p.heroid || p.id] || "Hero";
    const icoUrl = `mlbbicons/${(p.heroid || p.id || 0) + 1}.png`;

    const row = document.createElement("div");
    row.className = "roster-p";
    row.innerHTML = `
      <img class="roster-ico" src="${icoUrl}" onerror="this.style.display='none'">
      <span class="roster-name">${heroName}</span>
      <div class="roster-hp"><div class="roster-hp-bar" style="width:${Math.round(((p.hp||1)/(p.hm||1))*100)}%"></div></div>
    `;

    if (isAlly) allyDiv.appendChild(row);
    else enemyDiv.appendChild(row);
  });
}
