/**
 * Application Entry Point: Main game loop, telemetry, and network orchestration.
 */
import { state } from "./state.js";
import { drawScene, drawHero, drawJungle } from "./renderer.js";
import { updateDraftView, initDraftClipboard } from "./draft.js";
import { initControls } from "./controls.js";
import {
  evaluateGankThreats,
  drawThreatVectors,
  triggerGankVoiceAlert,
  getMacroState,
  getGankDebugState,
  setManualJungler,
  manualJunglerOverride,
  getMatchGameTime,
  HSMDebugConfig,
  setHSMDebugConfig,
  clearHSMTransitionHistory,
  hsmTransitionHistory
} from "./gank.js";
import { HEROES, getHeroName } from "./constants.js";

// Expose HSM & Jungler debug API on window for interactive browser debugging
window.HSMDebugConfig = HSMDebugConfig;
window.setHSMDebug = setHSMDebugConfig;
window.clearHSMHistory = clearHSMTransitionHistory;
window.getHSMHistory = () => hsmTransitionHistory;
window.setManualJungler = setManualJungler;

// Strip query parameters to avoid browser caching issues
if (window.location.search) {
  const cleanUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
  window.history.replaceState({}, document.title, cleanUrl);
}

// DOM References
const elements = {
  cv: document.getElementById("map"),
  ctx: document.getElementById("map").getContext("2d"),
  hud: document.getElementById("hud"),
  meta: document.getElementById("meta"),
  gankBanner: document.getElementById("gankBanner"),
  panel: document.getElementById("panel"),
  toggleBtn: document.getElementById("toggle"),
  profName: document.getElementById("profName"),
  mapfile: document.getElementById("mapfile"),
  sScale: document.getElementById("s_scale"),
  vScale: document.getElementById("v_scale"),
  sRot: document.getElementById("s_rot"),
  vRot: document.getElementById("v_rot"),
  sOx: document.getElementById("s_ox"),
  vOx: document.getElementById("v_ox"),
  sOy: document.getElementById("s_oy"),
  vOy: document.getElementById("v_oy"),
  sSkscale: document.getElementById("s_skscale"),
  vSkscale: document.getElementById("v_skscale"),
  sIconsize: document.getElementById("s_iconsize"),
  vIconsize: document.getElementById("v_iconsize"),
  bFlip: document.getElementById("b_flip"),
  bGrid: document.getElementById("b_grid"),
  bDbg: document.getElementById("b_dbg"),
  bGank: document.getElementById("b_gank"),
  bVoice: document.getElementById("b_voice"),
  bConf: document.getElementById("b_conf"),
  bConfHud: document.getElementById("b_conf_hud"),
  confDebugPanel: document.getElementById("confDebugPanel"),
  cdClose: document.getElementById("cd_close"),
  cdJunglerSelect: document.getElementById("cd_jungler_select"),
  cdMacroGrid: document.getElementById("cd_macro_grid"),
  cdWaveGrid: document.getElementById("cd_wave_grid"),
  cdThreatList: document.getElementById("cd_threat_list"),
  bHsm: document.getElementById("b_hsm"),
  cdHsmLogBtn: document.getElementById("cd_hsm_log_btn"),
  cdHsmClrBtn: document.getElementById("cd_hsm_clr_btn"),
  cdHsmList: document.getElementById("cd_hsm_list"),
  bFps: document.getElementById("b_fps"),
  bReset: document.getElementById("b_reset"),
  bCal1: document.getElementById("b_cal1"),
  bCal2: document.getElementById("b_cal2"),
  calStatus: document.getElementById("calstatus"),
  draftView: document.getElementById("draftView"),
  dvAlly: document.getElementById("dvAlly"),
  dvEnemy: document.getElementById("dvEnemy"),
  dvMeta: document.getElementById("dvMeta")
};

const controls = initControls(elements, () => {
  if (state.lastData) renderFrame(state.lastData);
});
initDraftClipboard(elements.draftView);

if (elements.cdJunglerSelect) {
  elements.cdJunglerSelect.addEventListener("change", (ev) => {
    const val = ev.target.value;
    localStorage.setItem("debug_manual_jungler", val);
    if (!val) {
      setManualJungler(null);
    } else {
      const heroes = state.lastData?.heroes || [];
      const found = heroes.find(h => String(h.g || h.id) === val || String(h.id) === val);
      if (found) {
        setManualJungler(found);
      } else {
        setManualJungler({ id: parseInt(val, 10), g: parseInt(val, 10), hn: ev.target.selectedOptions[0]?.text });
      }
    }
    if (state.lastData) renderFrame(state.lastData);
  });
}

let lastDebugRenderTime = 0;

function renderConfidenceDebug(dbg) {
  const now = performance.now();
  if (now - lastDebugRenderTime < 100) return;
  lastDebugRenderTime = now;

  const { cdMacroGrid, cdWaveGrid, cdThreatList } = elements;
  if (!cdMacroGrid || !cdWaveGrid || !cdThreatList) return;

  const m = dbg.macro || {};
  const w = dbg.wave || {};

  // 1. MACRO INTEL GRID
  const anchorStatus = m.anchorLocked
    ? `<span class="cd-pill ${m.anchorCleared ? 'safe' : 'alert'}">${m.firstBuffSide || 'LOCKED'} ➔ ${m.targetGankLane || 'LANE'}${m.anchorSource ? ` (${m.anchorSource})` : ''}</span>`
    : `<span class="cd-pill safe">IDLE</span>`;

  const earlyGankStatus = m.earlySameSideGank
    ? `<span class="cd-pill alert">ACTIVE (~${m.earlyGankTime ? m.earlyGankTime.toFixed(0) : 0}s)</span>`
    : `<span class="cd-pill safe">NO</span>`;

  const midPrioStatus = m.enemyMidLvl1Cleared
    ? `<span class="cd-pill warn">CLEARED Lv.1 (${m.midPrioTime ? m.midPrioTime.toFixed(0) : 0}s)</span>`
    : `<span class="cd-pill safe">NOT CLEARED</span>`;

  const lithoStatus = m.midContestingLitho
    ? `<span class="cd-pill active">CONTESTING (RIVER)</span>`
    : `<span class="cd-pill safe">CLEAR</span>`;

  let midFogStatus = `<span class="cd-pill safe">VISIBLE / IDLE</span>`;
  if (m.midRotationThreat) {
    const fogSec = m.midTimeInFog ? ` (${m.midTimeInFog}s)` : "";
    midFogStatus = `<span class="cd-pill alert">➔ ${m.midRotationThreat.targetLane}${fogSec}</span>`;
  }

  cdMacroGrid.innerHTML = `
    <div class="cd-row" style="grid-column: 1 / -1;"><span class="cd-k">HSM State Tree:</span><span class="cd-v"><span class="cd-pill active" style="font-size:9px;letter-spacing:0.2px;">${dbg.macroPath || 'MatchTempo ➔ PreMatch'}</span></span></div>
    <div class="cd-row"><span class="cd-k">Jungler:</span><span class="cd-v">${m.junglerName || 'Unknown'} ${m.manualJungler ? '<span class="cd-pill warn" style="font-size:7.5px;">MANUAL</span>' : ''}</span></div>
    <div class="cd-row"><span class="cd-k">1st Buff Anchor:</span><span class="cd-v">${anchorStatus}</span></div>
    <div class="cd-row"><span class="cd-k">Target Gank Lane:</span><span class="cd-v"><b>${m.targetGankLane || 'NONE'}</b> ${m.isInvade ? '<span class="cd-pill warn">INVADE</span>' : ''}</span></div>
    <div class="cd-row"><span class="cd-k">3-Camp Early Gank:</span><span class="cd-v">${earlyGankStatus}</span></div>
    <div class="cd-row"><span class="cd-k">Enemy Mid:</span><span class="cd-v">${m.enemyMidName || 'Unknown'}</span></div>
    <div class="cd-row"><span class="cd-k">Mid Wave 1 Prio:</span><span class="cd-v">${midPrioStatus}</span></div>
    <div class="cd-row"><span class="cd-k">Lithowanderer:</span><span class="cd-v">${lithoStatus}</span></div>
    <div class="cd-row"><span class="cd-k">Mid in River Fog:</span><span class="cd-v">${midFogStatus}</span></div>
    <div class="cd-row" style="grid-column: 1 / -1;"><span class="cd-k">Enemy Spells (sm):</span><span class="cd-v" style="font-size:9.5px;font-family:monospace;word-break:break-all;">${m.spellsSummary || 'Waiting for telemetry...'}</span></div>
  `;

  // 2. TURRET & WAVE STAGING GRID
  const turretZone = w.underOuterTurret
    ? `<span class="cd-pill active">ZONE (${typeof w.turretDist === 'number' ? w.turretDist.toFixed(1) : 0}u)</span>`
    : `<span class="cd-pill safe">OPEN FIELD</span>`;

  const waveStaged = w.waveStaged
    ? `<span class="cd-pill alert">STAGED (DIVE THREAT)</span>`
    : (w.unstagedWave
        ? `<span class="cd-pill warn">UNSTAGED (NO WAVE)</span>`
        : `<span class="cd-pill safe">SAFE / NORMAL</span>`);

  const minionDist = typeof w.waveDist === 'number' && w.waveDist < 999
    ? `${w.waveDist.toFixed(1)}u`
    : 'None near';

  const alertHold = (dbg.hold && dbg.hold.activeCount > 0)
    ? `<span class="cd-pill warn">${dbg.hold.activeCount} HELD (${dbg.hold.expiresInSeconds}s)</span>`
    : `<span class="cd-pill safe">NONE</span>`;

  cdWaveGrid.innerHTML = `
    <div class="cd-row"><span class="cd-k">Player Lane:</span><span class="cd-v"><b>${dbg.playerLane || 'UNKNOWN'}</b> ${dbg.isSidelane ? '<span class="cd-pill active">SIDELANE</span>' : ''}</span></div>
    <div class="cd-row"><span class="cd-k">Allied Turret:</span><span class="cd-v">${turretZone}</span></div>
    <div class="cd-row"><span class="cd-k">Wave Staging:</span><span class="cd-v">${waveStaged}</span></div>
    <div class="cd-row"><span class="cd-k">Closest Enemy Minion:</span><span class="cd-v">${minionDist}</span></div>
    <div class="cd-row"><span class="cd-k">Minions Under Turret:</span><span class="cd-v"><b>${w.enemyMinionsNearTurret || 0}</b></span></div>
    <div class="cd-row"><span class="cd-k">Alert Hold Buffer:</span><span class="cd-v">${alertHold}</span></div>
  `;

  // 3. TARGETS & CONFIDENCE PROBABILITIES
  if (!dbg.threats || dbg.threats.length === 0) {
    cdThreatList.innerHTML = `<div class="cd-empty">No active gank vectors or threats currently in range</div>`;
  } else {
    cdThreatList.innerHTML = dbg.threats.map(t => {
      const pct = typeof t.confidencePct === 'number' ? t.confidencePct : Math.round((t.confidence || 0.5) * 100);
      const confClass = pct >= 75 ? 'high' : (pct >= 50 ? 'med' : 'low');
      const isHot = pct >= 70 || t.macroType === 'FIRST_BUFF' || t.macroType === 'EARLY_GANK';

      const pills = [];
      if (t.macroType === 'FIRST_BUFF') pills.push(`<span class="cd-pill alert">HOT LANE</span>`);
      if (t.macroType === 'MID_PRIO') pills.push(`<span class="cd-pill warn">MID PRIO</span>`);
      if (t.macroType === 'EARLY_GANK') pills.push(`<span class="cd-pill alert">3-CAMP EARLY</span>`);
      if (t.flank) pills.push(`<span class="cd-pill alert">FLANK CUTOFF</span>`);
      if (t.unstagedWave) pills.push(`<span class="cd-pill safe">NO WAVE (ZONING)</span>`);
      if (t.prestack) pills.push(`<span class="cd-pill warn">PRE-STACK</span>`);
      if (t.lowHpDive && !t.unstagedWave) pills.push(`<span class="cd-pill alert">LOW HP DIVE</span>`);
      if (t.bush) pills.push(`<span class="cd-pill active">BUSH</span>`);
      else if (t.fog) pills.push(`<span class="cd-pill safe">FOG</span>`);

      return `
        <div class="cd-threat-item ${isHot ? 'hot' : ''}">
          <div class="cd-threat-head">
            <span class="cd-threat-name">${t.name} <span style="font-size:10px;color:var(--text-dim);font-weight:normal;">[${t.role || 'GANK'}]</span></span>
            <div>${pills.join(" ")}</div>
          </div>
          <div class="cd-meter">
            <span class="cd-k" style="font-size:9px;min-width:65px;">Confidence:</span>
            <div class="cd-meter-bar-bg">
              <div class="cd-meter-bar-fill ${confClass}" style="width: ${pct}%"></div>
            </div>
            <span class="cd-meter-val">${pct}%</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-top:3px;">
            <span>Dist: <b style="color:#eceff1">${t.dist}u</b></span>
            <span>Close Spd: <b style="color:#eceff1">${typeof t.closingSpeed === 'number' ? t.closingSpeed.toFixed(1) : 0}u/s</b></span>
            <span>ETA: <b style="color:${t.eta <= 3 ? 'var(--accent-red)' : 'var(--accent-teal)'}">~${t.eta}s</b></span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;padding-top:3px;border-top:1px solid rgba(255,255,255,0.05);font-size:9px;">
            <span class="cd-k">Tactical HSM:</span>
            <span style="color:var(--accent-teal);font-weight:bold;">${t.tacticalPath || 'Tactical ➔ Dormant'}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  // 4. HSM TRANSITION TELEMETRY & RECENT TRANSITIONS
  const { cdHsmList } = elements;
  if (cdHsmList && dbg.hsm) {
    const transitions = dbg.hsm.recentTransitions || [];
    if (transitions.length === 0) {
      cdHsmList.innerHTML = `<div class="cd-empty">No state transitions recorded yet</div>`;
    } else {
      // Show newest transitions at top
      cdHsmList.innerHTML = transitions.slice().reverse().map(tr => {
        const isMacro = tr.machine === "MacroHSM";
        const typeClass = isMacro ? "macro" : "tactical";
        const date = new Date(tr.time);
        const timeStr = `${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(Math.floor(date.getMilliseconds() / 100))}`;
        const gameTimeStr = tr.gameTime !== null ? ` [~${tr.gameTime.toFixed(0)}s]` : "";
        return `
          <div class="cd-hsm-item ${typeClass}">
            <div class="cd-hsm-head">
              <span class="cd-hsm-name">${tr.machine}</span>
              <span class="cd-hsm-time">${timeStr}${gameTimeStr}</span>
            </div>
            <div class="cd-hsm-path">${tr.fromState} <span class="cd-hsm-arrow">➔</span> <b>${tr.toState}</b></div>
            <div class="cd-hsm-detail">
              <span>LCA: <i>${tr.lca}</i></span>
              <span style="color:#90a4ae;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">${tr.reason || ''}</span>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Sync Enemy Jungler Select Options
  const { cdJunglerSelect } = elements;
  if (cdJunglerSelect && state.lastData && state.lastData.heroes) {
    const enemyHeroes = state.lastData.heroes.filter(h => {
      if (state.selfCamp) return h.camp !== state.selfCamp;
      return !h.ally;
    });

    const currentKey = manualJunglerOverride
      ? String(manualJunglerOverride.guid || manualJunglerOverride.id)
      : (localStorage.getItem("debug_manual_jungler") || "");
    const enemySig = enemyHeroes.map(h => String(h.g || h.id)).join(",");

    if (cdJunglerSelect.dataset.sig !== enemySig && document.activeElement !== cdJunglerSelect) {
      cdJunglerSelect.dataset.sig = enemySig;
      let opts = `<option value="">(Auto Detect)</option>`;
      for (const h of enemyHeroes) {
        const val = String(h.g || h.id);
        const name = getHeroName(h);
        const sel = (val === currentKey || String(h.id) === currentKey) ? "selected" : "";
        opts += `<option value="${val}" ${sel}>${name}</option>`;
      }
      cdJunglerSelect.innerHTML = opts;

      // Restore saved override if needed
      if (currentKey && !manualJunglerOverride) {
        const found = enemyHeroes.find(h => String(h.g || h.id) === currentKey || String(h.id) === currentKey);
        if (found) setManualJungler(found);
      }
    }
  }
}

function renderFrame(data) {
  const { cv, ctx, meta, gankBanner } = elements;
  drawScene(cv, ctx);

  if (data.bm) {
    const selfGuid = data.self ? data.self.g : -1;
    if (data.self) {
      drawHero(ctx, cv, data.self, true);
    }
    for (const h of data.heroes || []) {
      if (h.g === selfGuid) continue;
      drawHero(ctx, cv, h, false);
    }
    for (const m of data.jungle || []) {
      drawJungle(ctx, cv, m);
    }

    // Optional Gank Alert Detection (Toggleable in Settings)
    const gankEnabled = localStorage.getItem("mapgankalert") === "1";
    const confDebugEnabled = localStorage.getItem("mapgankconfdbg") === "1";
    const rawTime = (typeof data.gt === 'number' && data.gt >= 0) ? data.gt : (data.t || 0);
    const inBattle = !!data.self;
    const matchTime = getMatchGameTime(rawTime, inBattle, data.heroes || []);

    const threats = (data.self && (gankEnabled || confDebugEnabled))
      ? evaluateGankThreats(data.self, data.heroes || [], data.draft || [], rawTime, data.jungle || [])
      : [];

    if (threats.length > 0 && data.self && data.self.p && gankEnabled) {
      drawThreatVectors(ctx, cv, threats, data.self.p);
      triggerGankVoiceAlert(threats);

      const hasUnstagedWave = threats.some(t => t.unstagedWave);
      const isUnstaged3Man = threats.length >= 3 && hasUnstagedWave;
      // High-ELO wave check: if minion wave is not staged, 3-man dive is physically impossible without tanking tower naked -> de-escalate
      const threatLevel = isUnstaged3Man
        ? "threat-2"
        : (threats.length >= 3 ? "threat-3" : threats.length === 2 ? "threat-2" : "threat-1");

      if (gankBanner) {
        gankBanner.className = threatLevel;
        const threatList = threats.map(t => {
          let tags = [];
          const confStr = typeof t.confidencePct === 'number' ? ` ${t.confidencePct}%` : "";
          if (t.macroType === "FIRST_BUFF") tags.push(`HOT LANE 🔥${confStr}`);
          if (t.macroType === "MID_PRIO") tags.push(`MID PRIO ⚡${confStr}`);
          if (t.macroType === "EARLY_GANK") tags.push(`EARLY GANK ⚔️${confStr}`);
          if (t.flank) tags.push(`FLANK 🪓${confStr}`);
          if (t.unstagedWave) tags.push("NO WAVE STAGED 🛡️");
          if (t.prestack) tags.push("PRE-STACK ⚡");
          if (t.lowHpDive && !t.unstagedWave) tags.push("LOW HP DIVE 🩸");
          if (t.bush) tags.push("BUSH AMBUSH");
          else if (t.fog) tags.push("FOG");
          if (t.invis) tags.push("STEALTH");
          if (t.lvl) tags.push(`Lv.${t.lvl}`);
          if (typeof t.manaPct === 'number') {
            if (t.manaPct < 25) tags.push("LOW MANA");
            else if (t.manaPct >= 90) tags.push("FULL ENG");
          }
          if (typeof t.goldAdv === 'number' && t.goldAdv >= 1000) {
            tags.push(`+${Math.round(t.goldAdv / 100) / 10}k gld`);
          }
          const tagStr = tags.length ? ` • ${tags.join("/")}` : "";
          if (t.macroType === "FIRST_BUFF") {
            return `🎯 ${t.name} [HOT LANE${confStr}] (Clear dumps on ${t.targetLane} Lane ~1:20${tagStr})`;
          }
          if (t.macroType === "MID_PRIO") {
            return `⚡ ${t.name} [MID PRIO${confStr}] (Prio wave 1 & vanished into ${t.targetLane} river fog${tagStr})`;
          }
          if (t.macroType === "EARLY_GANK") {
            return `⚔️ ${t.name} [EARLY GANK${confStr}] (3-Camp collapse on ${t.targetLane} Lane ~${t.eta}s${tagStr})`;
          }
          if (t.flank) {
            return `🪓 ${t.name} [FLANK CUTOFF${confStr}] (${t.dist}u • Turret retreat blocked${tagStr})`;
          }
          return `${t.name} [${t.role || 'GANK'}${confStr}] (${t.dist}u • ~${t.eta}s${tagStr})`;
        }).join(" | ");

        const bannerTitle = isUnstaged3Man
          ? `🛡️ 3 COLLAPSING • NO WAVE STAGED (ZONING)`
          : `⚠️ GANK TELEMETRY (${threats.length})`;
        gankBanner.innerHTML = `${bannerTitle}: ${threatList}`;
        gankBanner.style.display = "flex";
      }
    } else if (gankBanner) {
      gankBanner.className = "";
      gankBanner.style.display = "none";
    }

    // Render Confidence & Heuristic States Live Debug Panel
    if (confDebugEnabled && elements.confDebugPanel && !elements.confDebugPanel.classList.contains("hidden")) {
      const debugState = getGankDebugState(data.self, data.heroes || [], data.draft || [], rawTime, data.jungle || [], threats);
      renderConfidenceDebug(debugState);
    }

    const fogN = (data.heroes || []).filter(h => h.fog && !h.ally).length;
    const visN = (data.heroes || []).length - fogN;
    const sideClass = state.selfCamp === 2 ? "side-r" : "side-b";
    const sideName = state.selfCamp === 2 ? "red" : "blue";

    // Macro Intel badges in HUD
    const macro = getMacroState();
    const macroBadges = [];
    if (macro.earlySameSideGank && matchTime <= 85) {
      macroBadges.push(`<span class="macro-hud early" title="3-Camp Vertical Jungle Clear">3-CAMP ➔ ${macro.targetGankLane} ⚔️ EARLY</span>`);
    } else if (macro.firstBuffSide && matchTime < 130) {
      const isHot = matchTime >= 70 && matchTime <= 105;
      macroBadges.push(`<span class="macro-hud jg ${isHot ? 'hot' : ''}" title="Enemy Jungler First Buff Anchor">JG 1st: ${macro.firstBuffSide} ➔ ${macro.targetGankLane} ${isHot ? '🔥 HOT' : '@ 1:20'}</span>`);
    }
    if (macro.midRotationThreat && performance.now() < macro.midRotationThreat.expiresAt) {
      macroBadges.push(`<span class="macro-hud mid" title="Mid Wave Priority Rotation">MID ➔ ${macro.midRotationThreat.targetLane} FOG</span>`);
    }
    const macroStr = macroBadges.length ? ` | ${macroBadges.join(" ")}` : "";

    meta.innerHTML = [
      `t=${matchTime.toFixed(1)}s`,
      `ent=${data.n || 0}`,
      `<span class="fog">fog: ${fogN}</span>`,
      `<span class="vis">vis: ${visN}</span>`,
      `side=<span class="${sideClass}">${sideName}</span>`,
      `<span class="ping">${state.lastPingMs}ms</span>`,
      `<span class="fps">${state.fps.toFixed(0)}fps</span>`
    ].join(" | ") + macroStr;
  } else {
    if (gankBanner) {
      gankBanner.className = "";
      gankBanner.style.display = "none";
    }
    const confDebugEnabled = localStorage.getItem("mapgankconfdbg") === "1";
    if (confDebugEnabled && elements.cdThreatList) {
      elements.cdThreatList.innerHTML = `<div class="cd-empty">No active match telemetry (Lobby / Draft)</div>`;
    }
  }
}

let targetFps = parseInt(localStorage.getItem("mapfps") || "60", 10);
if (isNaN(targetFps)) targetFps = 60;
let frameInterval = targetFps > 0 ? (1000 / targetFps) : 0;
let lastTickTime = 0;

window.setTargetFps = function(fps) {
  targetFps = typeof fps === 'number' && !isNaN(fps) ? fps : 60;
  frameInterval = targetFps > 0 ? (1000 / targetFps) : 0;
};

async function tick(now = performance.now()) {
  if (document.hidden || document.pictureInPictureElement) {
    setTimeout(tick, 16);
  } else {
    requestAnimationFrame(tick);
  }

  // Rate-limit polling /map.json and canvas rendering
  if (frameInterval > 0 && now - lastTickTime < frameInterval) {
    return;
  }
  lastTickTime = now - ((now - lastTickTime) % frameInterval);

  const fetchStart = performance.now();
  try {
    const response = await fetch(`map.json?x=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    state.lastPingMs = Math.round(performance.now() - fetchStart);
    state.connected = true;
    state.lastData = data;

    if (Array.isArray(data.heroes)) {
      window._loggedSummons = window._loggedSummons || {};
      for (const h of data.heroes) {
        if (h.g && h.sm !== undefined && h.sm !== -1 && window._loggedSummons[h.g] !== h.sm) {
          window._loggedSummons[h.g] = h.sm;
          const heroName = getHeroName(h);
          const allyStr = h.ally ? "ALLY" : "ENEMY";
          console.log(`%c[SUMMON] ${allyStr} "${heroName}" (g=${h.g}, camp=${h.camp}) -> summonSkillId = ${h.sm} (0x${h.sm.toString(16).toUpperCase()})`, "color: #00e5ff; font-weight: bold;");
        }
      }
    }

    updateDraftView(data, elements);

    const prevCamp = state.selfCamp;
    if (data.self && data.self.camp) {
      state.selfCamp = data.self.camp;
    }
    if (prevCamp !== state.selfCamp) {
      controls.syncSliders();
    }

    renderFrame(data);

    state.frames++;
    const now = performance.now();
    if (now - state.fpsTimer > 1000) {
      state.fps = (state.frames * 1000) / (now - state.fpsTimer);
      state.frames = 0;
      state.fpsTimer = now;
    }
  } catch (err) {
    state.connected = false;
    elements.meta.innerHTML = `<span class="offline">CONNECTING / OFFLINE (${err.message})</span>`;
    // Retain previous canvas frame during temporary network jitter
  }
}

// Start Game Loop
tick();
