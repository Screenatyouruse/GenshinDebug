/**
 * Gank & Collapse Vector Detection Engine
 * Specifically designed for the first 1-5 minutes of the match:
 * Warns sidelaners (EXP / Gold lane) when enemy Roamer, Mid, or Jungler is pathing towards them.
 * Features guaranteed alert lifespan (no flickering) and predictive canvas rays.
 */
import { HEROES, ROAD, CREEPS, getHeroName, isRetributionSpell, getSpellName } from "./constants.js";
import { worldToScreen } from "./coords.js";
import {
  State,
  HierarchicalStateMachine,
  MacroStates,
  TacticalStates,
  HSMDebugConfig,
  hsmTransitionHistory,
  setHSMDebugConfig,
  clearHSMTransitionHistory
} from "./hsm.js";

export {
  HSMDebugConfig,
  hsmTransitionHistory,
  setHSMDebugConfig,
  clearHSMTransitionHistory
};

// Enemy tracking history: hero GUID/ID -> { pos: [x, z], t: timestamp, vx: number, vz: number }
const history = new Map();

// Active threat timers for Schmitt-trigger hysteresis
const activeThreatTimers = new Map(); // heroKey -> lastActiveTimestamp

// Recall channel start timers: heroKey -> timestamp when recall started
const recallChannelStarts = new Map();

// Per-Hero Tactical Threat Hierarchical State Machines (Decoupled lifecycle from MacroHSM)
const tacticalHSMs = new Map(); // heroKey -> HierarchicalStateMachine

// Alert hold state: guarantees warning stays active and readable for at least 4.0s (no short-lifespan flickering)
const activeAlertHold = {
  threats: [],
  expiresAt: 0
};

// Alert cooldown timestamps for voice
let lastAudioTime = 0;
let lastAlertCount = 0;

/**
 * Global Macro State Tracking for High-ELO Match Intelligence:
 * 1. First Buff Anchor:
 *    Detects enemy Retribution cast on first buff (~0:20).
 *    If started Bot-side buff -> clear path dumps on Top lane at ~1:20 (Lv. 3/4).
 *    If started Top-side buff -> clear path dumps on Bot lane at ~1:20.
 *    That lane is permanently hot from 1:10 onward.
 *
 * 2. Mid Wave Priority:
 *    Tracks first mid wave clear speed (lvl 2 timing).
 *    If enemy mid clears wave 1 faster and vanishes into river fog (~0:30-0:45),
 *    the sidelane towards which they pathed is immediately under threat.
 */
export const macroState = {
  // First Buff Anchor
  junglerGuid: null,
  junglerId: null,
  junglerName: null,
  firstBuffSide: null,    // "BOT" or "TOP"
  firstBuffTime: 0,
  targetGankLane: null,   // "TOP" or "BOT" (opposite of firstBuffSide unless same-side/invade)
  anchorLocked: false,
  anchorCleared: false,
  anchorSource: null,
  isInvade: false,
  earlySameSideGank: false,
  earlyGankTime: 0,

  // Mid Wave Priority
  enemyMidGuid: null,
  enemyMidId: null,
  enemyMidName: null,
  allyMidGuid: null,
  enemyMidLvl1Cleared: false,
  midPrioTime: 0,
  midRotationThreat: null, // { targetLane, enemyMidName, enemyMidId, enemyMidGuid, exitTime, expiresAt, ex, ez }
  midContestingLitho: false,

  // Cooldown and level history for delta triggers
  prevSpells: new Map(), // guid -> prevSp
  prevLevels: new Map(), // guid -> prevLvl
  prevGameTime: 0
};

export const macroHSM = new HierarchicalStateMachine(macroState, MacroStates.PreMatch, { name: "MacroHSM" });

// Manual Jungler Override for Testing & Debugging
export let manualJunglerOverride = null;

export function setManualJungler(hero) {
  if (!hero) {
    manualJunglerOverride = null;
    macroState.junglerGuid = null;
    macroState.junglerId = null;
    macroState.junglerName = null;
    return;
  }
  const guid = hero.g ?? hero.guid ?? null;
  const id = hero.id ?? null;
  const name = getHeroName(hero);
  manualJunglerOverride = { guid, id, name };
  macroState.junglerGuid = guid;
  macroState.junglerId = id;
  macroState.junglerName = name;
}

export function getMacroState() {
  return macroState;
}

export function resetMacroState() {
  if (manualJunglerOverride) {
    macroState.junglerGuid = manualJunglerOverride.guid;
    macroState.junglerId = manualJunglerOverride.id;
    macroState.junglerName = manualJunglerOverride.name;
  } else {
    macroState.junglerGuid = null;
    macroState.junglerId = null;
    macroState.junglerName = null;
  }
  macroState.firstBuffSide = null;
  macroState.firstBuffTime = 0;
  macroState.targetGankLane = null;
  macroState.anchorLocked = false;
  macroState.anchorCleared = false;
  macroState.anchorSource = null;
  macroState.isInvade = false;
  macroState.earlySameSideGank = false;
  macroState.earlyGankTime = 0;

  macroState.enemyMidGuid = null;
  macroState.enemyMidId = null;
  macroState.enemyMidName = null;
  macroState.allyMidGuid = null;
  macroState.enemyMidLvl1Cleared = false;
  macroState.midPrioTime = 0;
  macroState.midRotationThreat = null;
  macroState.midContestingLitho = false;

  macroState.prevSpells.clear();
  macroState.prevLevels.clear();
  macroState.prevGameTime = 0;

  matchStartBootTime = 0;
  matchActive = false;

  if (macroHSM) {
    macroHSM.transitionTo(MacroStates.PreMatch, "Reset match state");
  }
  tacticalHSMs.clear();
}

/**
 * Determines lane ("TOP", "BOT", or "MID") from 3D world coordinates.
 * Screen Y is automatically normalized across both Blue and Red camp perspectives:
 * Screen Y < 315 = TOP lane (top of screen)
 * Screen Y > 405 = BOT lane (bottom of screen)
 * 315 <= Screen Y <= 405 = MID lane (center)
 */
export function getLaneFromPos(x, z) {
  const [, sy] = worldToScreen(x, z);
  if (sy < 315) return "TOP";
  if (sy > 405) return "BOT";
  return "MID";
}

/**
 * Gets current lane of the player entity.
 */
export function getPlayerLane(self) {
  if (!self || !self.p || self.p.length < 3) return null;
  return getLaneFromPos(self.p[0], self.p[2]);
}

/**
 * Checks if the player is playing a sidelane role (EXP or Gold lane).
 * Does not rely solely on draft roles because they are often missing or unreliable.
 */
export function isPlayerSidelaner(self, draft) {
  if (!self || !self.p || self.p.length < 3) return false;

  // 1. Dynamic positional check (player stationed in Top or Bot lane)
  const lane = getPlayerLane(self);
  if (lane === "TOP" || lane === "BOT") return true;

  // 2. Draft role fallback
  if (Array.isArray(draft) && draft.length > 0) {
    const p = draft.find(d => d.camp === self.camp && (d.heroid === self.id || (self.uid && d.uid === self.uid)));
    if (p && p.road) {
      return p.road === 1 || p.road === 2;
    }
  }

  // 3. Radial distance fallback
  const [x, , z] = self.p;
  const distFromCenter = Math.hypot(x, z);
  if (distFromCenter >= 14 && distFromCenter <= 52) {
    return Math.abs(x) > 12 || Math.abs(z) > 12;
  }

  return false;
}

/**
 * Checks if an approaching enemy is assigned to Roam (4), Mid (3), or Jungle (5).
 * Dynamically resolves role from Retribution spell usage, macro tracking, or draft.
 */
export function getGankerRoleName(enemyHero, draft, selfCamp) {
  if (!enemyHero) return null;

  // 1. Dynamic macro tracking
  if (macroState.junglerGuid && enemyHero.g === macroState.junglerGuid) {
    return "JUNGLE";
  }
  if (macroState.enemyMidGuid && enemyHero.g === macroState.enemyMidGuid) {
    return "MID";
  }

  // 2. Summoner spell check: Retribution spell or active cooldown indicates jungler
  if (isRetributionSpell(enemyHero.sm) || (typeof enemyHero.sp === 'number' && enemyHero.sp >= 0 && enemyHero.sp <= 36)) {
    return "JUNGLE";
  }

  // 3. Draft role check if available
  if (Array.isArray(draft) && draft.length > 0) {
    const p = draft.find(d => d.camp !== selfCamp && (d.heroid === enemyHero.id || (enemyHero.uid && d.uid === enemyHero.uid)));
    if (p && p.road) {
      if (p.road === 3) return "MID";
      if (p.road === 4) return "ROAM";
      if (p.road === 5) return "JUNGLE";
      return null;
    }
  }

  return "ROAM";
}

// Web Audio API discreet radar tick / ping for competitive high-ELO players
let audioCtx = null;
export function playRadarPing(type = 'tick') {
  try {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;

    if (type === 'tick') {
      // Subtle, high-frequency radar tick/blip (soft acoustic click)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(450, now + 0.035);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (type === 'hot') {
      // Clean acoustic two-tone chime (880Hz -> 1320Hz)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.05);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    }
  } catch (e) {
    // AudioContext blocked or unsupported
  }
}

/**
 * Evaluates minion wave proximity to the player's allied outer turret.
 * In high-ELO MLBB, a 3-man dive under allied turret is physically impossible
 * without an enemy minion wave tanking tower shots naked.
 *
 * @param {Object} self - Local player entity
 * @param {Array} jungle - Jungle & minion entities from data.jungle
 * @param {number} gameTime - Match clock in seconds
 * @returns {Object} { nearTurret, waveStaged, waveDist, minionCount }
 */
export function evaluateTurretWaveProximity(self, jungle = [], gameTime = 0) {
  if (!self || !self.p || self.p.length < 3) {
    return {
      nearTurret: false,
      underOuterTurret: false,
      turretDist: 99,
      waveStaged: false,
      unstagedWave: false,
      waveDist: 99,
      minionCount: 0,
      enemyMinionsNearTurret: 0
    };
  }

  const playerLane = getPlayerLane(self);
  if (!playerLane || (playerLane === "MID" && Math.abs(self.p[0]) > 25)) {
    return {
      nearTurret: false,
      underOuterTurret: false,
      turretDist: 99,
      waveStaged: false,
      unstagedWave: false,
      waveDist: 99,
      minionCount: 0,
      enemyMinionsNearTurret: 0
    };
  }

  // Allied outer turret world coordinates
  // Blue (Camp 1): base left (X < 0). Red (Camp 2): base right (X > 0).
  const isRed = self.camp === 2;
  const turretX = isRed ? 14 : -14;
  let turretZ = 0;
  if (playerLane === "TOP") turretZ = 32;
  else if (playerLane === "BOT") turretZ = -32;
  else turretZ = 0; // MID

  const [sx, , sz] = self.p;
  const distToTurret = Math.hypot(sx - turretX, sz - turretZ);
  // Player is positioned defensively under or right next to their allied outer turret
  const nearTurret = distToTurret <= 18;

  // 1. Search for live enemy minions in data.jungle
  let closestEnemyMinionDist = 999;
  let enemyMinionCount = 0;

  if (Array.isArray(jungle) && jungle.length > 0) {
    for (const m of jungle) {
      if (!m.p || m.death) continue;
      // Minion entity IDs (1000 - 1199) with non-turret HP (< 3000)
      if (m.id >= 1000 && m.id < 1200 && (m.hm || 0) < 3000) {
        // Enemy minion (camp differs from self)
        const isEnemyMinion = (typeof m.camp === 'number') ? (m.camp !== self.camp) : true;
        if (isEnemyMinion) {
          const mDist = Math.hypot(m.p[0] - turretX, m.p[2] - turretZ);
          if (mDist < closestEnemyMinionDist) {
            closestEnemyMinionDist = mDist;
          }
          if (mDist <= 22) {
            enemyMinionCount++;
          }
        }
      }
    }
  }

  if (closestEnemyMinionDist < 900) {
    const waveStaged = closestEnemyMinionDist <= 18;
    return {
      nearTurret,
      underOuterTurret: nearTurret,
      turretDist: Math.round(distToTurret * 10) / 10,
      waveStaged,
      unstagedWave: nearTurret && !waveStaged,
      waveDist: Math.round(closestEnemyMinionDist),
      minionCount: enemyMinionCount,
      enemyMinionsNearTurret: enemyMinionCount
    };
  }

  // 2. Schedule fallback: MLBB wave cycles (every 30s at 0:10, 0:40, 1:10, 1:40...)
  // Waves take ~22s to arrive at outer turrets and clash until ~30s.
  if (gameTime >= 10) {
    const waveAge = (gameTime - 10) % 30;
    const waveStaged = waveAge >= 21 && waveAge <= 29;
    const waveDist = waveStaged ? 6 : Math.round(Math.abs(21 - waveAge) * 1.6);
    return {
      nearTurret,
      underOuterTurret: nearTurret,
      turretDist: Math.round(distToTurret * 10) / 10,
      waveStaged,
      unstagedWave: nearTurret && !waveStaged,
      waveDist,
      minionCount: waveStaged ? 3 : 0,
      enemyMinionsNearTurret: waveStaged ? 3 : 0
    };
  }

  return {
    nearTurret,
    underOuterTurret: nearTurret,
    turretDist: Math.round(distToTurret * 10) / 10,
    waveStaged: false,
    unstagedWave: nearTurret,
    waveDist: 40,
    minionCount: 0,
    enemyMinionsNearTurret: 0
  };
}

let matchStartBootTime = 0;
let matchActive = false;

/**
 * Normalizes system uptime / raw seconds into match-elapsed game time (0s - 300s+).
 * Starts our own internal timer when player is in battle (bm=1 / self present).
 * If rawTime < 1000, it is already match-elapsed seconds (from unit tests or data.gt).
 */
export function getMatchGameTime(rawTime = 0, inBattle = true, heroes = []) {
  if (!inBattle) {
    matchStartBootTime = 0;
    matchActive = false;
    return 0;
  }

  // Already elapsed match seconds (e.g. simulated test or data.gt < 1000)
  if (typeof rawTime === 'number' && rawTime >= 0 && rawTime < 1000) {
    return rawTime;
  }

  const currentUptime = (typeof rawTime === 'number' && rawTime >= 1000)
    ? rawTime
    : (performance.now() / 1000);

  // If match just started or clock rewound
  if (!matchActive || matchStartBootTime === 0 || currentUptime < matchStartBootTime - 5) {
    matchActive = true;
    const maxLvl = Array.isArray(heroes) && heroes.length > 0
      ? Math.max(...heroes.map(h => (typeof h.lvl === 'number' && h.lvl > 0 ? h.lvl : 1)))
      : 1;

    let initialOffset = 15;
    if (maxLvl >= 4) initialOffset = 85;
    else if (maxLvl >= 2) initialOffset = 40;

    matchStartBootTime = currentUptime - initialOffset;
  }

  return Math.max(0, currentUptime - matchStartBootTime);
}

/**
 * High-ELO Macro State Updater:
 * Tracks early game creep combat (Rockursa/Fiend/Serpent/Crammer HP & animation)
 * and Retribution casts (First Buff Anchor) and Mid wave priority rotations.
 */
export function updateMacroState(self, heroes, gameTime = 0, jungle = []) {
  if (!self || !Array.isArray(heroes)) return;

  const inBattle = !!(self && self.p && (!self.death || (typeof self.hp === 'number' && self.hp > 0)));
  const effectiveGameTime = getMatchGameTime(gameTime, inBattle, heroes);

  const now = performance.now();

  // Reset match state on match restart or clock rewind
  if (effectiveGameTime < 12 || effectiveGameTime < macroState.prevGameTime - 5) {
    resetMacroState();
  }
  macroState.prevGameTime = effectiveGameTime;

  // Update MacroHSM match tempo transitions
  if (effectiveGameTime >= 12 && effectiveGameTime < 120) {
    if (macroHSM.currentState === MacroStates.PreMatch && !macroState.anchorLocked) {
      macroHSM.transitionTo(MacroStates.ScanningAnchor, "Match clock >= 12s, scanning 1st buff anchor");
    }
  } else if (effectiveGameTime >= 120) {
    macroHSM.transitionTo(MacroStates.MidGame, "Match clock >= 120s, mid-game macro tempo");
    macroState.anchorCleared = true;
  }

  const selfGuid = self.g;

  // 0. Auto-resolve Enemy Jungler via Retribution spell ID
  if (!manualJunglerOverride && !macroState.junglerGuid) {
    const jg = heroes.find(h => !h.ally && h.g && isRetributionSpell(h.sm));
    if (jg) {
      macroState.junglerGuid = jg.g;
      macroState.junglerId = jg.id;
      macroState.junglerName = getHeroName(jg);
    }
  }

  // 1. Track Mid Laners during early match (t in [12, 45])
  if (effectiveGameTime >= 12 && effectiveGameTime <= 45) {
    for (const h of heroes) {
      if (h.death || !h.p) continue;
      const lane = getLaneFromPos(h.p[0], h.p[2]);
      if (lane === "MID") {
        if (!h.ally && h.g !== selfGuid && !macroState.enemyMidGuid) {
          macroState.enemyMidGuid = h.g;
          macroState.enemyMidId = h.id;
          macroState.enemyMidName = getHeroName(h);
        } else if ((h.ally || h.g === selfGuid) && !macroState.allyMidGuid) {
          macroState.allyMidGuid = h.g;
        }
      }
    }
  }

  // 2. FIRST BUFF ANCHOR: Track Creep HP & Combat Animations and Retribution (t in [14, 75])
  if (!macroState.anchorLocked && effectiveGameTime >= 14 && effectiveGameTime <= 75) {
    // 2A. Primary Creep Combat Scan: Rockursa (2009), Crammer (2008, 2059), Fiend (2004), Serpent (2005), Scaled Lizard (2006)
    // When attacked, creep HP drops (hp < hm) and animation transitions out of idle (e.g. 'run', 'attack')
    const BUFF_CAMP_CREEPS = new Set([2004, 2005, 2006, 2008, 2009, 2059]);
    if (Array.isArray(jungle) && jungle.length > 0) {
      for (const m of jungle) {
        if (!m.p || m.death) continue;
        if (!BUFF_CAMP_CREEPS.has(m.id)) continue;

        const isDamaged = (typeof m.hp === 'number' && typeof m.hm === 'number' && m.hm > 0 && m.hp < m.hm);
        const anim = (typeof m.an === 'string') ? m.an.toLowerCase() : "";
        const isCombatAnim = anim !== "" && anim !== "idle" && anim !== "fight_idle" && anim !== "dead";

        if (isDamaged || isCombatAnim) {
          const buffSide = getLaneFromPos(m.p[0], m.p[2]);
          if (buffSide !== "TOP" && buffSide !== "BOT") continue;

          // Determine if creep is in enemy jungle vs ally jungle:
          // Blue base is x < 0 (camp 1), Red base is x > 0 (camp 2).
          // If self is camp 1 (Blue), enemy jungle is x > 2. If self is camp 2 (Red), enemy jungle is x < -2.
          const isEnemyJungle = (self.camp === 2) ? (m.p[0] < -2) : (m.p[0] > 2);
          const isAllyJungle = (self.camp === 2) ? (m.p[0] > 2) : (m.p[0] < -2);

          const creepName = CREEPS[m.id] || `#${m.id}`;
          const stateDesc = isDamaged ? `HP ${m.hp}/${m.hm}` : `anim '${m.an}'`;

          if (isEnemyJungle) {
            macroState.firstBuffSide = buffSide;
            macroState.targetGankLane = (buffSide === "BOT") ? "TOP" : "BOT";
            macroState.firstBuffTime = effectiveGameTime;
            macroState.anchorLocked = true;
            macroState.isInvade = false;
            macroState.anchorSource = `${creepName} (${stateDesc})`;

            macroHSM.transitionTo(
              MacroStates.CrossMapPath,
              `1st buff anchored via enemy ${creepName} (${stateDesc}) on ${buffSide} ➔ ${macroState.targetGankLane}`
            );
            break;
          } else if (isAllyJungle) {
            // Check if enemy jungler or enemy hero is near our buff camp (Invade!)
            const jgNear = heroes.some(h => !h.ally && h.p && Math.hypot(h.p[0] - m.p[0], h.p[2] - m.p[2]) < 15);
            if (jgNear) {
              macroState.firstBuffSide = buffSide;
              macroState.targetGankLane = buffSide;
              macroState.firstBuffTime = effectiveGameTime;
              macroState.anchorLocked = true;
              macroState.isInvade = true;
              macroState.anchorSource = `Invade on ${creepName} (${stateDesc})`;

              macroHSM.transitionTo(
                MacroStates.InvadePath,
                `Enemy invade anchored via ally ${creepName} (${stateDesc}) on ${buffSide} side`
              );
              break;
            }
          }
        }
      }
    }

    // 2B. Retribution Spell Cooldown & Sighting Fallback
    if (!macroState.anchorLocked) {
      for (const h of heroes) {
        if (h.ally || h.g === selfGuid || h.death || !h.p) continue;

        const heroKey = h.g || h.id;
        const prevSp = macroState.prevSpells.get(heroKey);
        const curSp = typeof h.sp === 'number' ? h.sp : -1;
        macroState.prevSpells.set(heroKey, curSp);

        const buffSide = getLaneFromPos(h.p[0], h.p[2]);
        const isRetriCast = (prevSp !== undefined && prevSp <= 3 && curSp >= 20);
        const isRetriActive = (curSp >= 16 && curSp <= 36 && effectiveGameTime >= 18 && effectiveGameTime <= 55);
        const isAtFirstBuff = (h.g === macroState.junglerGuid && effectiveGameTime >= 18 && effectiveGameTime <= 45 && (buffSide === "TOP" || buffSide === "BOT"));

        if ((isRetriCast || isRetriActive || isAtFirstBuff) && (buffSide === "TOP" || buffSide === "BOT")) {
          macroState.junglerGuid = h.g;
          macroState.junglerId = h.id;
          macroState.junglerName = getHeroName(h);
          macroState.firstBuffSide = buffSide;

          // EDGE CASE 4: False Anchor Lock via Invasive Retribution
          const isInvade = (self.camp === 1 && h.p[0] < -5) || (self.camp === 2 && h.p[0] > 5);
          macroState.isInvade = isInvade;
          macroState.anchorSource = isRetriCast ? "Retri Cast" : (isRetriActive ? "Retri CD" : "Hero Sighted");

          if (isInvade) {
            macroState.targetGankLane = buffSide;
            macroHSM.transitionTo(MacroStates.InvadePath, `Enemy Retri invade detected on ${buffSide} side`);
          } else {
            macroState.targetGankLane = (buffSide === "BOT") ? "TOP" : "BOT";
            macroHSM.transitionTo(MacroStates.CrossMapPath, `First buff Retri locked on ${buffSide} ➔ ${macroState.targetGankLane}`);
          }

          macroState.firstBuffTime = effectiveGameTime;
          macroState.anchorLocked = true;
          break;
        }
      }
    }
  }

  // EDGE CASE 2: The 3-Camp Vertical Jungle Clear (Early Same-Side Gank at 0:45 - 1:10)
  // If enemy jungler is sighted on the SAME side as their starting buff (e.g. Bot when started Bot),
  // they skipped cross-map clear for an early aggressive same-side gank!
  if (macroState.anchorLocked && !macroState.isInvade && effectiveGameTime >= 45 && effectiveGameTime <= 75) {
    const jg = heroes.find(h => (h.g && h.g === macroState.junglerGuid) || h.id === macroState.junglerId);
    if (jg && jg.p) {
      const currentJgLane = getLaneFromPos(jg.p[0], jg.p[2]);
      const isSameSide = (currentJgLane === macroState.firstBuffSide) ||
        (macroState.firstBuffSide === "BOT" && jg.p[2] < -10) ||
        (macroState.firstBuffSide === "TOP" && jg.p[2] > 10);
      if (isSameSide) {
        macroState.targetGankLane = macroState.firstBuffSide;
        macroState.earlySameSideGank = true;
        macroState.earlyGankTime = effectiveGameTime;
        macroHSM.transitionTo(MacroStates.Vertical3Camp, `Vertical 3-camp early gank on ${macroState.firstBuffSide}`);
      }
    }
  }

  // Clear anchor if jungler shows visibly in the non-target lane during hot window
  if (macroState.anchorLocked && !macroState.anchorCleared && effectiveGameTime >= 70) {
    const jg = heroes.find(h => (h.g && h.g === macroState.junglerGuid) || h.id === macroState.junglerId);
    if (jg && !jg.fog && jg.p) {
      const currentJgLane = getLaneFromPos(jg.p[0], jg.p[2]);
      if (currentJgLane !== "MID" && currentJgLane !== macroState.targetGankLane) {
        macroState.anchorCleared = true;
      }
    }
  }

  // 3. MID WAVE PRIORITY: First wave clear speed & fog disappearance (~0:18 - 0:52)
  // EDGE CASE 6: Fast wave clears happen as early as 18s (Novaria S2, Luo Yi, Lylia)
  if (macroState.enemyMidGuid && effectiveGameTime >= 18 && effectiveGameTime <= 65) {
    const enemyMid = heroes.find(h => h.g === macroState.enemyMidGuid || h.id === macroState.enemyMidId);
    const allyMid = heroes.find(h => h.g === macroState.allyMidGuid);

    if (enemyMid && enemyMid.p) {
      const prevLvl = macroState.prevLevels.get(enemyMid.g) || 1;
      const curLvl = enemyMid.lvl || 1;
      macroState.prevLevels.set(enemyMid.g, curLvl);

      // Mid wave 1 gives Level 2 instantly upon clearing all 3 minions
      if (curLvl >= 2 && prevLvl < 2) {
        const allyMidLvl = (allyMid && allyMid.lvl) ? allyMid.lvl : 1;
        if (allyMidLvl < 2 || effectiveGameTime <= 36) {
          macroState.enemyMidLvl1Cleared = true;
          macroState.midPrioTime = effectiveGameTime;
        }
      }

      // Check if enemy mid pathing into river and disappearing into fog at ~0:20 - 0:48
      if (effectiveGameTime >= 20 && effectiveGameTime <= 52 && !macroState.midRotationThreat) {
        const [mex, , mez] = enemyMid.p;

        // EDGE CASE 1: Inverted River Pathing (Contesting Lithowanderer)
        // Lithowanderer pocket is at river center (|mex| <= 12 and |mez| <= 15).
        // If Mid is in this pocket, they are contesting Litho / river scuttle, NOT ganking a sidelane!
        const isLithoPocket = Math.abs(mex) <= 12 && Math.abs(mez) <= 15;

        if (isLithoPocket) {
          macroState.midContestingLitho = true;
        } else if (Math.abs(mez) > 16 || Math.abs(mex) > 16) {
          macroState.midContestingLitho = false;
          const currentMidLane = getLaneFromPos(mex, mez);

          let exitSide = null;
          if (currentMidLane === "TOP" || mez > 16 || (enemyMid.dir && enemyMid.dir[1] > 0.35)) {
            exitSide = "TOP";
          } else if (currentMidLane === "BOT" || mez < -16 || (enemyMid.dir && enemyMid.dir[1] < -0.35)) {
            exitSide = "BOT";
          }

          // Trigger preemptive rotation warning when they leave mid past Litho and vanish into fog
          if (exitSide && (enemyMid.fog || enemyMid.grass > 0 || Math.abs(mez) > 18)) {
            macroState.midRotationThreat = {
              targetLane: exitSide,
              enemyMidName: macroState.enemyMidName || "Enemy Mid",
              enemyMidId: enemyMid.id,
              enemyMidGuid: enemyMid.g,
              exitTime: effectiveGameTime,
              expiresAt: now + 18000, // 18-second threat window across river
              ex: mex,
              ez: mez
            };
          }
        }
      }
    }
  }

  // Expire mid rotation threat when timer finishes or mid is seen elsewhere
  if (macroState.midRotationThreat) {
    if (now >= macroState.midRotationThreat.expiresAt) {
      macroState.midRotationThreat = null;
    } else {
      const enemyMid = heroes.find(h => h.g === macroState.midRotationThreat.enemyMidGuid);
      if (enemyMid && !enemyMid.fog && enemyMid.p) {
        const currentLane = getLaneFromPos(enemyMid.p[0], enemyMid.p[2]);
        if (currentLane === "MID" || (currentLane !== macroState.midRotationThreat.targetLane && currentLane !== "MID")) {
          macroState.midRotationThreat = null;
        }
      }
    }
  }
}

/**
 * Evaluates all enemy heroes and macro vectors to detect ganks on sidelaners.
 * Features:
 * - First Buff Anchor: Target lane is permanently hot from 1:10 onward.
 * - Mid Wave Priority: Disappearing into fog at ~0:35 puts pathed sidelane immediately under threat.
 * - Hybrid Rate-of-Closure: Euclidean Doppler range shrinking + stick vector projection.
 * - 2.0s Continuous Recall Timer: suppresses only after 2.0s continuous channel.
 * - High ELO Low-HP Dives: alerts low HP dives.
 * - Pre-Stack Detection: Joy dashes, War Axe, Martis combat staging.
 * - Flank & Choke-Point Cut-Off: catches perpendicular sprint/conceal wraps.
 *
 * @param {Object} self - Player entity { p: [x, y, z], g: number, camp: number, id: number }
 * @param {Array} heroes - List of all hero entities in battle
 * @param {Array} draft - Draft roster data with role/road assignments
 * @param {number} gameTime - Match clock in seconds (data.t)
 * @param {Array} jungle - Jungle monsters and objectives
 * @returns {Array} List of active threats
 */
export function evaluateGankThreats(self, heroes, draft = [], gameTime = 0, jungle = []) {
  if (!self || !self.p || !Array.isArray(heroes)) {
    return [];
  }

  // Master toggle: only active if user enabled gank alert in settings
  if (typeof localStorage !== "undefined" && localStorage.getItem("mapgankalert") !== "1") {
    activeAlertHold.threats = [];
    activeAlertHold.expiresAt = 0;
    return [];
  }

  const inBattle = !self.death || (typeof self.hp === 'number' && self.hp > 0);
  const effectiveGameTime = getMatchGameTime(gameTime, inBattle, heroes);
  const now = performance.now();

  // Always keep high-ELO macro intelligence state fresh
  updateMacroState(self, heroes, effectiveGameTime, jungle);

  // Active during early game window (20s to 300s)
  if (effectiveGameTime < 20 || effectiveGameTime > 300) {
    activeAlertHold.threats = [];
    activeAlertHold.expiresAt = 0;
    return [];
  }

  const playerLane = getPlayerLane(self);
  const isSidelane = isPlayerSidelaner(self, draft);

  // Staged wave proximity evaluation
  const waveStatus = evaluateTurretWaveProximity(self, jungle, effectiveGameTime);

  // EDGE CASE 5: Sanitization - purge hold buffer if player died, recalled to base, or left sidelane
  if (self.death || (typeof self.hp === 'number' && self.hp <= 0)) {
    activeAlertHold.threats = [];
    activeAlertHold.expiresAt = 0;
    return [];
  }
  const [sx, , sz] = self.p;
  if (Math.abs(sx) > 42 && Math.abs(sz) < 12) { // Player in base fountain
    activeAlertHold.threats = [];
    activeAlertHold.expiresAt = 0;
    return [];
  }
  if (!isSidelane && (!playerLane || playerLane === "MID")) {
    activeAlertHold.threats = [];
    activeAlertHold.expiresAt = 0;
    return [];
  }

  const selfGuid = self.g;
  const newThreats = [];

  // =========================================================================
  // MACRO THREAT 1: First Buff Anchor / Early Same-Side Gank
  // =========================================================================
  if (macroState.anchorLocked && !macroState.anchorCleared) {
    // 1a. Early 3-camp same-side gank (t in [45, 80])
    if (macroState.earlySameSideGank && effectiveGameTime >= 45 && effectiveGameTime <= 80) {
      if (playerLane === macroState.targetGankLane) {
        const jg = heroes.find(h => (h.g && h.g === macroState.junglerGuid) || h.id === macroState.junglerId);
        const jgX = (jg && jg.p) ? jg.p[0] : (playerLane === "TOP" ? -15 : 15);
        const jgZ = (jg && jg.p) ? jg.p[2] : (playerLane === "TOP" ? 32 : -32);
        const dist = Math.hypot(sx - jgX, sz - jgZ);

        const earlyConf = (Math.abs(sx - jgX) < 25 && Math.abs(sz - jgZ) < 25) ? 0.95 : 0.85;
        newThreats.push({
          id: macroState.junglerId || 0,
          guid: macroState.junglerGuid || 0,
          name: macroState.junglerName || "Enemy Jungler",
          role: "JUNGLE",
          macroType: "EARLY_GANK",
          earlyGank: true,
          confidence: earlyConf,
          confidencePct: Math.round(earlyConf * 100),
          unstagedWave: false,
          waveDist: waveStatus.waveDist,
          targetLane: macroState.targetGankLane,
          startedSide: macroState.firstBuffSide,
          dist: Math.round(dist),
          speed: 4.2,
          closingSpeed: 3.0,
          eta: Math.max(1, Math.round(dist / 3.5)),
          fog: jg ? !!jg.fog : true,
          lvl: (jg && jg.lvl) ? jg.lvl : 2,
          ex: jgX,
          ez: jgZ,
          sx, sz,
          vx: 0, vz: 0
        });
      }
    }
    // 1b. Standard Hot Lane clear dump (t in [70, 105])
    else if (!macroState.earlySameSideGank && effectiveGameTime >= 70 && effectiveGameTime <= 105) {
      if (playerLane === macroState.targetGankLane) {
        const jg = heroes.find(h => (h.g && h.g === macroState.junglerGuid) || h.id === macroState.junglerId);
        const jgX = (jg && jg.p) ? jg.p[0] : (playerLane === "TOP" ? -15 : 15);
        const jgZ = (jg && jg.p) ? jg.p[2] : (playerLane === "TOP" ? 32 : -32);
        const dist = Math.hypot(sx - jgX, sz - jgZ);

        const hotConf = Math.min(0.92, 0.75 + Math.max(0, effectiveGameTime - 70) * 0.015);
        newThreats.push({
          id: macroState.junglerId || 0,
          guid: macroState.junglerGuid || 0,
          name: macroState.junglerName || "Enemy Jungler",
          role: "JUNGLE",
          macroType: "FIRST_BUFF",
          hotLane: true,
          isInvade: macroState.isInvade,
          confidence: Math.round(hotConf * 100) / 100,
          confidencePct: Math.round(hotConf * 100),
          unstagedWave: false,
          waveDist: waveStatus.waveDist,
          targetLane: macroState.targetGankLane,
          startedSide: macroState.firstBuffSide,
          dist: Math.round(dist),
          speed: 4.2,
          closingSpeed: 2.8,
          eta: Math.max(1, Math.round(80 - effectiveGameTime)),
          fog: jg ? !!jg.fog : true,
          lvl: (jg && jg.lvl) ? jg.lvl : 4,
          ex: jgX,
          ez: jgZ,
          sx, sz,
          vx: 0, vz: 0
        });
      }
    }
  }

  // =========================================================================
  // MACRO THREAT 2: Mid Wave Priority
  // =========================================================================
  if (macroState.midRotationThreat && now < macroState.midRotationThreat.expiresAt) {
    if (playerLane === macroState.midRotationThreat.targetLane) {
      const rot = macroState.midRotationThreat;
      const enemyMid = heroes.find(h => (h.g && h.g === rot.enemyMidGuid) || h.id === rot.enemyMidId);
      const midX = (enemyMid && enemyMid.p) ? enemyMid.p[0] : rot.ex;
      const midZ = (enemyMid && enemyMid.p) ? enemyMid.p[2] : rot.ez;
      const dist = Math.hypot(sx - midX, sz - midZ);

      // Confidence scoring for Mid Wave Priority:
      // Base: 40% (0.40) if mid entered river without wave clear confirm
      // +25% (0.65) if wave 1 cleared confirmed
      // +10% (0.75) if unseen in fog >= 3s
      // +20% (0.85) if unseen in fog >= 6s
      let midConf = 0.40;
      if (macroState.enemyMidLvl1Cleared) {
        midConf = 0.65;
      }
      const timeInFog = (typeof gameTime === 'number' && rot.exitTime)
        ? Math.max(0, gameTime - rot.exitTime)
        : Math.max(0, (now - (rot.expiresAt - 18000)) / 1000);

      if (timeInFog >= 6) {
        midConf += 0.20;
      } else if (timeInFog >= 3) {
        midConf += 0.10;
      }
      midConf = Math.min(0.95, midConf);

      newThreats.push({
        id: rot.enemyMidId || 0,
        guid: rot.enemyMidGuid || 0,
        name: rot.enemyMidName || "Enemy Mid",
        role: "MID",
        macroType: "MID_PRIO",
        preemptive: true,
        confidence: Math.round(midConf * 100) / 100,
        confidencePct: Math.round(midConf * 100),
        unstagedWave: false,
        waveDist: waveStatus.waveDist,
        targetLane: rot.targetLane,
        dist: Math.round(dist),
        speed: 4.2,
        closingSpeed: 3.2,
        eta: Math.max(2, Math.round(dist / 3.5)),
        fog: true,
        lvl: (enemyMid && enemyMid.lvl) ? enemyMid.lvl : 2,
        ex: midX,
        ez: midZ,
        sx, sz,
        vx: 0, vz: 0
      });
    }
  }

  // =========================================================================
  // TACTICAL THREATS: Live Enemy Vector Collapse, Flanks, & Rate-of-Closure
  // =========================================================================
  for (const h of heroes) {
    if (h.ally || h.g === selfGuid || h.death || !h.p) {
      continue;
    }

    const gankerRole = getGankerRoleName(h, draft, self.camp);
    if (!gankerRole) {
      continue;
    }

    const [ex, , ez] = h.p;
    const heroKey = h.g || h.id;
    const prev = history.get(heroKey);

    const dx = sx - ex;
    const dz = sz - ez;
    const dist = Math.hypot(dx, dz);

    if (!prev) {
      history.set(heroKey, {
        pos: [ex, ez],
        t: now,
        gameTime: (typeof gameTime === 'number' && gameTime > 0) ? gameTime : null,
        vx: 0,
        vz: 0,
        dist,
        rangeRate: 0
      });
      continue;
    }

    let dt = (now - prev.t) / 1000;
    if (typeof gameTime === 'number' && typeof prev.gameTime === 'number' && gameTime > prev.gameTime) {
      dt = gameTime - prev.gameTime;
    }

    let vx = prev.vx || 0;
    let vz = prev.vz || 0;
    let rangeRate = prev.rangeRate || 0;

    if (dt >= 0.10) {
      const rawVx = (ex - prev.pos[0]) / dt;
      const rawVz = (ez - prev.pos[1]) / dt;
      vx = 0.65 * rawVx + 0.35 * (prev.vx || 0);
      vz = 0.65 * rawVz + 0.35 * (prev.vz || 0);

      // Rate of closure (Range Rate / Doppler)
      if (typeof prev.dist === 'number' && dt > 0) {
        rangeRate = (prev.dist - dist) / dt;
      }

      history.set(heroKey, {
        pos: [ex, ez],
        t: now,
        gameTime: (typeof gameTime === 'number' && gameTime > 0) ? gameTime : null,
        vx,
        vz,
        dist,
        rangeRate
      });
    }

    const speed = Math.hypot(vx, vz);

    // Only discard if outside maximum collapse envelope (> 52u).
    // Note: Do NOT discard dist < 8u! Point-blank ganks are lethal active contacts!
    if (dist > 52) {
      continue;
    }

    // High ELO Health evaluation
    const hpRatio = (h.hp && h.hm && h.hm > 0) ? (h.hp / h.hm) : 1.0;
    const isVeryLowHp = hpRatio < 0.10;
    if (isVeryLowHp && rangeRate < -0.6) {
      continue;
    }
    const isLowHpDive = hpRatio >= 0.10 && hpRatio < 0.30;

    // Recall & Dead action check
    const anim = (typeof h.an === 'string') ? h.an.toLowerCase() : "";
    if (anim.includes("dead")) {
      recallChannelStarts.delete(heroKey);
      continue;
    }

    // 2.0s Continuous Recall Timer
    const isRecallAnim = anim.includes("home") || anim.includes("recall") || anim.includes("teleport");
    if (isRecallAnim) {
      if (!recallChannelStarts.has(heroKey)) {
        recallChannelStarts.set(heroKey, now);
      }
    } else {
      recallChannelStarts.delete(heroKey);
    }
    const recallDurationMs = recallChannelStarts.has(heroKey) ? (now - recallChannelStarts.get(heroKey)) : 0;
    const isConfirmedRecall = isRecallAnim && recallDurationMs >= 2000;
    if (isConfirmedRecall && dist > 14) {
      continue;
    }

    let vxNative = vx;
    let vzNative = vz;
    let speedNative = speed;
    if (Array.isArray(h.dir) && h.dir.length >= 2 && (h.dir[0] !== 0 || h.dir[1] !== 0)) {
      const nativeSpeed = (typeof h.spd === 'number' && h.spd > 50) ? (h.spd / 65) : speed;
      vxNative = h.dir[0] * nativeSpeed;
      vzNative = h.dir[1] * nativeSpeed;
      speedNative = nativeSpeed;
    }

    // Pre-stacking evaluation (Joy, War Axe, Martis)
    const isPrestacking = !!(h.bat && dist <= 38 && (rangeRate >= -0.6 || (speedNative > 0 && (vxNative * dx + vzNative * dz) > 0)));

    if (h.bat && dist > 36 && rangeRate < -0.8) {
      continue;
    }

    const isLurkingInBush = (h.grass && h.grass > 0) && dist <= 28 && speedNative < 2.0;

    const dot = (vxNative * dx + vzNative * dz) / (Math.max(0.1, speedNative) * dist);
    const closingSpeedVector = speedNative * dot;
    const effectiveClosingSpeed = Math.max(closingSpeedVector, rangeRate);

    const lastActive = activeThreatTimers.get(heroKey);
    const isCurrentlyActive = lastActive && (now - lastActive < 1400);

    // EDGE CASE 3: Roamer Conceal / Sprint Blind-Angle Flank (Perpendicular Wrap)
    // Detects when an enemy roamer/ganker is inside the sidelane corridor (|ez| >= 16 and |sz| >= 16),
    // within lethal flank range (dist <= 35u), moving at high speed (speedNative >= 2.5u/s),
    // cutting off the turret retreat even if vector dot product is perpendicular (~0).
    const isSameSidelaneZone = (ez > 16 && sz > 16) || (ez < -16 && sz < -16);
    const isFlankCutoff = isSameSidelaneZone && dist <= 35 && speedNative >= 2.5 && rangeRate >= -1.2;

    const isApproachingByStick = dot > 0.65 && closingSpeedVector > 1.2;
    const isApproachingByRange = rangeRate > 1.3 && dist <= 44;

    const isThreat = isLurkingInBush || isPrestacking || isFlankCutoff || (isCurrentlyActive
      ? ((dot > 0.35 || rangeRate > 0.4 || isFlankCutoff) && (effectiveClosingSpeed > 0.4 || isFlankCutoff))
      : (isApproachingByStick || isApproachingByRange || isFlankCutoff));

    if (isThreat) {
      activeThreatTimers.set(heroKey, now);
      const etaSeconds = isLurkingInBush ? 2 : Math.max(1, Math.round(dist / Math.max(0.2, Math.max(effectiveClosingSpeed, speedNative * 0.7))));
      const heroName = getHeroName(h);

      // Tactical Threat HSM state transition
      let heroHSM = tacticalHSMs.get(heroKey);
      if (!heroHSM) {
        heroHSM = new HierarchicalStateMachine(
          { id: h.id, g: h.g, name: heroName },
          TacticalStates.Dormant,
          { name: `Tactical:${heroName}` }
        );
        tacticalHSMs.set(heroKey, heroHSM);
      }

      if (isFlankCutoff) {
        heroHSM.transitionTo(TacticalStates.FlankCutoff, `Flank corridor cutoff (spd ${speedNative.toFixed(1)}u/s, dist ${dist.toFixed(1)}u)`);
      } else if (waveStatus.nearTurret) {
        if (waveStatus.waveStaged) {
          heroHSM.transitionTo(TacticalStates.StagedDive, `Under allied turret with staged wave (${waveStatus.waveDist.toFixed(1)}u)`);
        } else {
          heroHSM.transitionTo(TacticalStates.UnstagedZoning, `Under allied turret without wave (${waveStatus.waveDist.toFixed(1)}u)`);
        }
      } else {
        heroHSM.transitionTo(TacticalStates.OpenField, `Open field approach (dist ${dist.toFixed(1)}u, rate ${rangeRate.toFixed(1)})`);
      }

      // Tactical machine queries MacroHSM as an external input (Decoupled dual lifecycle)
      const isJungler = (macroState.junglerGuid && h.g === macroState.junglerGuid) || h.id === macroState.junglerId;
      const isEnemyMid = (macroState.enemyMidGuid && h.g === macroState.enemyMidGuid) || h.id === macroState.enemyMidId;

      let macroType = null;
      if (macroHSM.isInState("CrossMapPath") && isJungler && playerLane === macroState.targetGankLane && gameTime >= 70 && gameTime <= 105) {
        macroType = "FIRST_BUFF";
      } else if (macroHSM.isInState("Vertical3Camp") && isJungler && playerLane === macroState.targetGankLane && gameTime >= 45 && gameTime <= 80) {
        macroType = "EARLY_GANK";
      } else if (macroState.midRotationThreat && isEnemyMid && playerLane === macroState.midRotationThreat.targetLane) {
        macroType = "MID_PRIO";
      }

      // Tactical confidence scoring
      let conf = 0.70;
      if (isFlankCutoff) {
        conf = (speedNative >= 4.5 || speed >= 4.5) ? 0.95 : 0.88;
      } else if (isLurkingInBush) {
        conf = 0.88;
      } else if (isPrestacking) {
        conf = 0.85;
      } else {
        const dotFactor = Math.max(0, dot);
        const speedFactor = Math.min(1.0, Math.max(0, closingSpeedVector / 5.0));
        conf = Math.min(0.92, Math.max(0.50, 0.45 + dotFactor * 0.25 + speedFactor * 0.22));
      }

      if (macroType === "FIRST_BUFF") {
        conf = Math.max(conf, Math.min(0.92, 0.75 + Math.max(0, gameTime - 70) * 0.015));
      } else if (macroType === "EARLY_GANK") {
        conf = Math.max(conf, 0.85);
      }

      if (isLowHpDive) {
        conf = Math.min(0.95, conf + 0.05);
      }

      // Filter Out Staged Waves:
      // If player is under allied turret and no enemy wave is staged, an incoming 3-man dive
      // is physically impossible without tanking tower shots naked.
      const isUnstagedWaveThreat = waveStatus.nearTurret && !waveStatus.waveStaged;
      if (isUnstagedWaveThreat) {
        conf = Math.min(conf, 0.45);
      }

      const manaPct = (h.mm && h.mm > 0) ? Math.round((h.mp / h.mm) * 100) : null;
      const goldAdv = (typeof h.gld === 'number' && typeof self.gld === 'number' && h.gld > 0 && self.gld > 0)
        ? (h.gld - self.gld)
        : null;

      const existingIdx = newThreats.findIndex(t => (t.guid && t.guid === h.g) || t.id === h.id);
      const threatObj = {
        id: h.id,
        guid: h.g,
        name: heroName,
        role: gankerRole,
        macroType: macroType || (existingIdx >= 0 ? newThreats[existingIdx].macroType : null),
        tacticalPath: heroHSM.getPathString(),
        hsmState: heroHSM.currentState ? heroHSM.currentState.name : "Dormant",
        confidence: Math.round(conf * 100) / 100,
        confidencePct: Math.round(conf * 100),
        unstagedWave: isUnstagedWaveThreat,
        waveDist: waveStatus.waveDist,
        dist: Math.round(dist),
        speed: Math.round(speedNative * 10) / 10,
        closingSpeed: Math.round(effectiveClosingSpeed * 10) / 10,
        eta: etaSeconds,
        fog: !!h.fog,
        invis: !!(h.inv && h.inv !== 58),
        bush: isLurkingInBush,
        prestack: isPrestacking,
        flank: isFlankCutoff,
        lowHpDive: isLowHpDive,
        lvl: h.lvl || null,
        manaPct,
        goldAdv,
        anim,
        ex, ez,
        sx, sz,
        vx: vxNative,
        vz: vzNative
      };

      if (existingIdx >= 0) {
        if (newThreats[existingIdx].macroType === "MID_PRIO" && h.fog) {
          const macroConf = newThreats[existingIdx].confidence;
          const macroConfPct = newThreats[existingIdx].confidencePct;
          newThreats[existingIdx] = Object.assign(newThreats[existingIdx], threatObj, {
            confidence: macroConf,
            confidencePct: macroConfPct
          });
        } else {
          newThreats[existingIdx] = Object.assign(newThreats[existingIdx], threatObj);
        }
      } else {
        newThreats.push(threatObj);
      }
    } else if (!isFlankCutoff && (dot <= 0 || effectiveClosingSpeed <= 0)) {
      activeThreatTimers.delete(heroKey);
      const heroHSM = tacticalHSMs.get(heroKey);
      if (heroHSM && heroHSM.currentState !== TacticalStates.Dormant) {
        heroHSM.transitionTo(TacticalStates.Dormant, "Threat resolved / moving away");
      }
    }
  }

  // Guaranteed Lifespan / Hold Buffer:
  // If new threats are active, refresh hold timer for 4.2s
  if (newThreats.length > 0) {
    newThreats.sort((a, b) => a.dist - b.dist);
    activeAlertHold.threats = newThreats;
    activeAlertHold.expiresAt = now + 4200;
    return activeAlertHold.threats;
  }

  // EDGE CASE 5: Sanitized Hold Buffer - Drop stale threats if player swapped lanes, or enemy disengaged
  if (now < activeAlertHold.expiresAt && activeAlertHold.threats.length > 0) {
    const validHold = activeAlertHold.threats.filter(t => {
      // If threat was for a specific lane and player is no longer in that lane, drop it
      if (t.targetLane && playerLane && t.targetLane !== playerLane) {
        return false;
      }
      if (t.macroType === "FIRST_BUFF") {
        return macroState.anchorLocked && !macroState.anchorCleared && gameTime >= 70 && gameTime <= 105;
      }
      if (t.macroType === "EARLY_GANK") {
        return macroState.earlySameSideGank && gameTime >= 45 && gameTime <= 80;
      }
      if (t.macroType === "MID_PRIO") {
        return macroState.midRotationThreat && now < macroState.midRotationThreat.expiresAt;
      }
      const h = heroes.find(hero => (hero.g && hero.g === t.guid) || hero.id === t.id);
      if (!h || h.death) return false;
      // If enemy has flashed or retreated away (> 46u), do not hold ghost rays
      if (h.p) {
        const curDist = Math.hypot(sx - h.p[0], sz - h.p[2]);
        if (curDist > 46) return false;
      }
      return true;
    });

    if (validHold.length > 0) {
      return validHold;
    }
  }

  activeAlertHold.threats = [];
  activeAlertHold.expiresAt = 0;
  return [];
}

/**
 * Draws predictive gank rays, macro danger zones, and warning circles on the radar canvas.
 */
export function drawThreatVectors(ctx, cv, threats, selfPos) {
  if (!threats || threats.length === 0 || !selfPos) return;

  const cx = cv.width / 2;
  const cy = cv.height / 2;
  const [smx, smy] = worldToScreen(selfPos[0], selfPos[2], cx, cy);

  const threatCount = threats.length;
  const alertColor = threatCount >= 3 ? "#ef5350" : threatCount === 2 ? "#ff9800" : "#ffca28";

  // Pulsing danger ring around player
  const pulseR = 26 + (Math.sin(performance.now() / 150) * 4);
  ctx.save();
  ctx.beginPath();
  ctx.arc(smx, smy, pulseR, 0, Math.PI * 2);
  ctx.strokeStyle = alertColor;
  ctx.lineWidth = threatCount >= 2 ? 3 : 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.restore();

  // Draw threat rays & macro beacons
  for (const t of threats) {
    const [emx, emy] = worldToScreen(t.ex, t.ez, cx, cy);

    // MACRO OVERLAY: First Buff Anchor Hot Lane Badge
    if (t.macroType === "FIRST_BUFF") {
      ctx.save();
      // Pulsing hazard zone on hot lane entrance
      const hazardR = 22 + (Math.sin(performance.now() / 120) * 3);
      ctx.beginPath();
      ctx.arc(emx, emy, hazardR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(239, 83, 80, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "#ef5350";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();

      // Connector ray to player
      ctx.beginPath();
      ctx.moveTo(emx, emy);
      ctx.lineTo(smx, smy);
      ctx.strokeStyle = "#ef5350";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -performance.now() / 35;
      ctx.stroke();

      // Floating Hot Lane Badge
      const midX = (emx + smx) / 2;
      const midY = (emy + smy) / 2;
      ctx.setLineDash([]);
      ctx.fillStyle = "#0b0f14";
      ctx.strokeStyle = "#ef5350";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(midX - 55, midY - 11, 110, 22, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ff8a80";
      ctx.font = "bold 9px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`🔥 HOT LANE (${t.confidencePct || 85}%) • ~${t.eta}s`, midX, midY);
      ctx.restore();
      continue;
    }

    // MACRO OVERLAY: Mid Wave Priority Rotation Ray
    if (t.macroType === "MID_PRIO") {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(emx, emy);
      ctx.lineTo(smx, smy);
      ctx.strokeStyle = "#ce93d8";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -performance.now() / 35;
      ctx.stroke();

      const midX = (emx + smx) / 2;
      const midY = (emy + smy) / 2;
      ctx.setLineDash([]);
      ctx.fillStyle = "#0b0f14";
      ctx.strokeStyle = "#ab47bc";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(midX - 60, midY - 11, 120, 22, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#e1bee7";
      ctx.font = "bold 9px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`⚡ MID PRIO (${t.confidencePct || 85}%) • FOG`, midX, midY);
      ctx.restore();
      continue;
    }

    // MACRO OVERLAY: Early Same-Side Gank Ray
    if (t.macroType === "EARLY_GANK") {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(emx, emy);
      ctx.lineTo(smx, smy);
      ctx.strokeStyle = "#ff7043";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -performance.now() / 30;
      ctx.stroke();

      const midX = (emx + smx) / 2;
      const midY = (emy + smy) / 2;
      ctx.setLineDash([]);
      ctx.fillStyle = "#0b0f14";
      ctx.strokeStyle = "#ff7043";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(midX - 55, midY - 11, 110, 22, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffab91";
      ctx.font = "bold 9px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`⚔️ EARLY GANK (${t.confidencePct || 90}%) • ~${t.eta}s`, midX, midY);
      ctx.restore();
      continue;
    }

    // STANDARD / FLANK / UNSTAGED VECTOR THREAT
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(emx, emy);
    ctx.lineTo(smx, smy);
    const strokeCol = t.unstagedWave ? "#90a4ae" : (t.flank ? "#ff5722" : (t.fog ? "#ffb74d" : alertColor));
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = t.flank ? 3.0 : 2.5;
    ctx.setLineDash(t.flank ? [4, 4] : (t.unstagedWave ? [3, 3] : [8, 6]));
    ctx.lineDashOffset = -performance.now() / 40;
    ctx.stroke();

    const midX = (emx + smx) / 2;
    const midY = (emy + smy) / 2;

    ctx.setLineDash([]);
    ctx.fillStyle = "#0b0f14";
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = t.flank ? 1.5 : 1;
    ctx.beginPath();
    ctx.roundRect(midX - 44, midY - 9, 88, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = t.unstagedWave ? "#b0bec5" : (t.flank ? "#ff8a80" : "#eceff1");
    ctx.font = "bold 9px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let label = "";
    if (t.unstagedWave) {
      label = `ZONING (${t.confidencePct}%) • ~${t.eta}s`;
    } else if (t.flank) {
      label = `FLANK (${t.confidencePct}%) • ~${t.eta}s`;
    } else {
      label = `${t.role || 'INBOUND'} (${t.confidencePct}%) • ${t.eta}s`;
    }
    ctx.fillText(label, midX, midY);
    ctx.restore();
  }
}

/**
 * Triggers calm telemetry voice callouts and discreet acoustic radar pings.
 * Strictly avoids panicky backseat coaching ("Critical! Retreat to tower!").
 */
export function triggerGankVoiceAlert(threats) {
  if (!threats || threats.length === 0) {
    lastAlertCount = 0;
    return;
  }

  const count = threats.length;
  const now = performance.now();
  const escalated = count > lastAlertCount;

  // Discreet radar acoustic tick/ping on new threat or escalation
  if (escalated || now - lastAudioTime > 5000) {
    const hasHotLane = threats.some(t => t.macroType === "FIRST_BUFF" || t.macroType === "EARLY_GANK");
    playRadarPing(hasHotLane ? 'hot' : 'tick');
  }

  const voiceEnabled = (typeof localStorage !== "undefined") ? localStorage.getItem("mapgankvoice") !== "0" : false;
  if (!voiceEnabled) {
    lastAlertCount = count;
    return;
  }

  if (!escalated && now - lastAudioTime < 6500) {
    return;
  }

  lastAudioTime = now;
  lastAlertCount = count;

  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

  const hasUnstagedWave = threats.some(t => t.unstagedWave);
  const firstBuffThreat = threats.find(t => t.macroType === "FIRST_BUFF");
  const earlyGankThreat = threats.find(t => t.macroType === "EARLY_GANK");
  const midPrioThreat = threats.find(t => t.macroType === "MID_PRIO");
  const flankThreat = threats.find(t => t.flank);

  let phrase = "";
  if (count >= 3 && hasUnstagedWave) {
    phrase = "Three near lane. No wave staged.";
  } else if (count >= 3) {
    phrase = "Three collapsing. Hot lane.";
  } else if (count === 2) {
    phrase = `Two collapsing, ${threats[0].name} and ${threats[1].name}.`;
  } else if (flankThreat) {
    phrase = `Flank cutoff, ${flankThreat.name || flankThreat.role}.`;
  } else if (earlyGankThreat) {
    phrase = `Early gank, ${earlyGankThreat.targetLane}.`;
  } else if (firstBuffThreat) {
    phrase = `Hot lane, ${firstBuffThreat.targetLane}.`;
  } else if (midPrioThreat) {
    phrase = `Mid rotation, ${midPrioThreat.targetLane} river.`;
  } else {
    phrase = `${threats[0].name}, inbound.`;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.rate = 1.2;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    // TTS suppressed or unsupported
  }
}

/**
 * Returns a comprehensive telemetry snapshot of all heuristic engines and confidence states.
 * Designed for real-time live telemetry debugging in the confidence HUD menu.
 *
 * @param {Object} self - Player entity
 * @param {Array} heroes - Hero entities list
 * @param {Array} draft - Draft roster
 * @param {number} gameTime - Match clock in seconds
 * @param {Array} jungle - Jungle / minion entities
 * @param {Array} threats - Currently active gank threats
 * @returns {Object} Comprehensive heuristic state snapshot
 */
export function getGankDebugState(self, heroes = [], draft = [], gameTime = 0, jungle = [], threats = []) {
  const inBattle = !!(self && self.p && (!self.death || (typeof self.hp === 'number' && self.hp > 0)));
  const effectiveGameTime = getMatchGameTime(gameTime, inBattle, heroes);
  const macro = getMacroState();
  const wave = evaluateTurretWaveProximity(self, jungle, effectiveGameTime);
  const playerLane = getPlayerLane(self);
  const isSidelane = isPlayerSidelaner(self, draft);
  const now = (typeof performance !== 'undefined') ? performance.now() : 0;
  const holdExpiresIn = Math.max(0, Math.round((activeAlertHold.expiresAt - now) / 100) / 10);

  const midTimeInFog = (macro.midRotationThreat && typeof effectiveGameTime === 'number')
    ? Math.max(0, effectiveGameTime - (macro.midRotationThreat.exitTime || effectiveGameTime)).toFixed(1)
    : null;

  const detectedSpells = (heroes || [])
    .filter(h => !h.ally)
    .map(h => {
      const spellName = (h.sm !== undefined && h.sm !== -1) ? getSpellName(h.sm) : null;
      return {
        name: getHeroName(h),
        sm: (h.sm !== undefined && h.sm !== -1) ? h.sm : null,
        spellName,
        sp: (typeof h.sp === 'number' && h.sp >= 0) ? h.sp : null
      };
    });

  const spellsSummary = detectedSpells.length > 0
    ? detectedSpells.map(s => `${s.name}: ${s.spellName ? `${s.spellName} (${s.sm})` : (s.sp !== null ? `CD=${s.sp}s` : '?')}`).join(" | ")
    : "Waiting for telemetry...";

  return {
    gameTime: typeof effectiveGameTime === 'number' ? effectiveGameTime.toFixed(1) : "0.0",
    playerLane,
    isSidelane,
    wave,
    macroPath: macroHSM ? macroHSM.getPathString() : "PreMatch",
    macro: {
      anchorLocked: macro.anchorLocked,
      firstBuffSide: macro.firstBuffSide,
      firstBuffTime: macro.firstBuffTime,
      targetGankLane: macro.targetGankLane,
      anchorSource: macro.anchorSource,
      isInvade: macro.isInvade,
      earlySameSideGank: macro.earlySameSideGank,
      earlyGankTime: macro.earlyGankTime,
      anchorCleared: macro.anchorCleared,
      junglerName: macro.junglerName,
      manualJungler: manualJunglerOverride,
      enemyMidName: macro.enemyMidName,
      enemyMidLvl1Cleared: macro.enemyMidLvl1Cleared,
      midPrioTime: macro.midPrioTime,
      midContestingLitho: macro.midContestingLitho,
      midRotationThreat: macro.midRotationThreat,
      midTimeInFog,
      detectedSpells,
      spellsSummary
    },
    hold: {
      activeCount: (activeAlertHold.threats || []).length,
      expiresInSeconds: holdExpiresIn
    },
    threats: (threats || []).map(t => ({
      id: t.id,
      guid: t.guid,
      name: t.name,
      role: t.role,
      macroType: t.macroType || null,
      tacticalPath: t.tacticalPath || (tacticalHSMs.get(t.guid || t.id)?.getPathString() || "Tactical ➔ Dormant"),
      confidence: t.confidence,
      confidencePct: t.confidencePct,
      unstagedWave: !!t.unstagedWave,
      waveDist: t.waveDist,
      dist: t.dist,
      speed: t.speed,
      closingSpeed: t.closingSpeed,
      eta: t.eta,
      flank: !!t.flank,
      bush: !!t.bush,
      prestack: !!t.prestack,
      lowHpDive: !!t.lowHpDive,
      fog: !!t.fog
    })),
    hsm: {
      config: { ...HSMDebugConfig },
      macroTransitions: macroHSM ? macroHSM.transitionCount : 0,
      activeTacticalCount: tacticalHSMs.size,
      recentTransitions: hsmTransitionHistory.slice(-25)
    }
  };
}
