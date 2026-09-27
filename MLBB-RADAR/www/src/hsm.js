/**
 * Hierarchical State Machine (HSM) Engine
 * High-performance, zero-allocation statechart engine designed for 60 FPS MOBA radar loops:
 * - Precomputed ancestry & depths (O(1) LCA search without heap allocations)
 * - Allocation-free transitionTo using static scratch buffers
 * - Zero-allocation update(dt) iterating over cached active hierarchy
 * - Memoized path strings
 * - Clean decoupling: MacroHSM (match tempo/prio) vs TacticalThreatHSM (per-hero proximity/dive/flank)
 */

// Reusable scratch buffers for LCA transitions (avoids Garbage Collection churn on 60fps loops)
const _exitScratch = [];
const _enterScratch = [];

/**
 * HSM Debug Configuration
 * Controls diagnostic feedback, console logging, ring buffer history, and telemetry hooks.
 */
export const HSMDebugConfig = {
  enabled: false,           // Master debug feedback toggle
  logConsole: false,        // Print transitions and LCA events to console
  recordHistory: true,      // Maintain circular history buffer of transitions
  maxHistory: 40,           // Ring buffer capacity
  onTransition: null,       // Optional callback hook (record) => void
};

export const hsmTransitionHistory = [];
let _transitionSeq = 0;

export function recordHSMTransition(record) {
  if (!HSMDebugConfig.recordHistory) return;
  if (hsmTransitionHistory.length >= HSMDebugConfig.maxHistory) {
    hsmTransitionHistory.shift();
  }
  hsmTransitionHistory.push(record);
  if (typeof HSMDebugConfig.onTransition === "function") {
    try { HSMDebugConfig.onTransition(record); } catch (e) {}
  }
}

export function clearHSMTransitionHistory() {
  hsmTransitionHistory.length = 0;
}

export function setHSMDebugConfig(cfg = {}) {
  Object.assign(HSMDebugConfig, cfg);
  return HSMDebugConfig;
}

export class State {
  /**
   * @param {string} name - State identifier
   * @param {State|null} parent - Optional parent super-state
   */
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;

    // Precalculate ancestry chain from root down to this state
    const chain = [];
    let curr = this;
    while (curr) {
      chain.unshift(curr);
      curr = curr.parent;
    }
    this.ancestry = chain;
    this.depth = chain.length;
    this.pathString = chain.map(s => s.name).join(" ➔ ");
  }

  enter(ctx) {}
  exit(ctx) {}
  update(ctx, dt) {}
  handle(event, ctx) { return false; }
  getPath() { return this.ancestry.map(s => s.name); }
}

export class HierarchicalStateMachine {
  /**
   * @param {Object} ctx - Shared context object
   * @param {State|null} initialState - Starting state
   * @param {Object} options - Diagnostic and debug options { name, debug }
   */
  constructor(ctx = {}, initialState = null, options = {}) {
    this.ctx = ctx;
    this.name = options.name || "HSM";
    this.debug = options.debug ?? null; // null = inherit HSMDebugConfig.enabled
    this.currentState = null;
    this.activeHierarchy = []; // Cached active hierarchy: [root, ..., leaf]
    this.transitionCount = 0;
    this.lastTransition = null;
    if (initialState) {
      this.transitionTo(initialState, "initial_state");
    }
  }

  /**
   * Allocation-free atomic transition calculating the Lowest Common Ancestor (LCA).
   * @param {State} targetState
   * @param {string} reason - Optional diagnostic reason for debug feedback
   * @returns {boolean}
   */
  transitionTo(targetState, reason = "") {
    if (!targetState || this.currentState === targetState) {
      return false;
    }

    const current = this.currentState;
    _exitScratch.length = 0;
    _enterScratch.length = 0;

    let lcaIndex = 0;
    if (!current) {
      const tgtAncestry = targetState.ancestry;
      for (let i = 0; i < tgtAncestry.length; i++) {
        _enterScratch.push(tgtAncestry[i]);
      }
    } else {
      const currAncestry = current.ancestry;
      const tgtAncestry = targetState.ancestry;

      const minLen = Math.min(currAncestry.length, tgtAncestry.length);
      while (lcaIndex < minLen && currAncestry[lcaIndex] === tgtAncestry[lcaIndex]) {
        lcaIndex++;
      }

      // Exit from current leaf up to LCA (exclusive)
      for (let i = currAncestry.length - 1; i >= lcaIndex; i--) {
        _exitScratch.push(currAncestry[i]);
      }

      // Enter from LCA (exclusive) down to target leaf
      for (let i = lcaIndex; i < tgtAncestry.length; i++) {
        _enterScratch.push(tgtAncestry[i]);
      }
    }

    // Fire exits (leaf -> parent)
    for (let i = 0; i < _exitScratch.length; i++) {
      _exitScratch[i].exit(this.ctx);
    }

    // Fire enters (parent -> leaf)
    for (let i = 0; i < _enterScratch.length; i++) {
      _enterScratch[i].enter(this.ctx);
    }

    this.currentState = targetState;
    this.activeHierarchy = targetState.ancestry;
    this.transitionCount++;

    // Diagnostic record & debug telemetry feedback
    const lcaName = (current && lcaIndex > 0) ? current.ancestry[lcaIndex - 1].name : (current ? "ROOT" : "INIT");
    const record = {
      id: ++_transitionSeq,
      time: Date.now(),
      gameTime: typeof this.ctx?.gameTime === "number" ? this.ctx.gameTime : null,
      machine: this.name,
      from: current ? current.pathString : "NONE",
      to: targetState.pathString,
      fromState: current ? current.name : "NONE",
      toState: targetState.name,
      lca: lcaName,
      reason: reason || "",
      depth: targetState.depth
    };
    this.lastTransition = record;

    if (HSMDebugConfig.recordHistory) {
      recordHSMTransition(record);
    }

    const shouldLog = (this.debug === true || (this.debug === null && (HSMDebugConfig.enabled || HSMDebugConfig.logConsole))) && HSMDebugConfig.logConsole;
    if (shouldLog) {
      console.log(`[HSM:${this.name}] ${record.fromState} ➔ ${record.toState} (LCA: ${record.lca}${reason ? ` | ${reason}` : ''})`);
    }

    return true;
  }

  /**
   * Zero-allocation hot path update for 60 FPS game loop.
   * @param {number} dt
   */
  update(dt = 0) {
    const hierarchy = this.activeHierarchy;
    for (let i = 0; i < hierarchy.length; i++) {
      hierarchy[i].update(this.ctx, dt);
    }
  }

  /**
   * Event bubbling through parent states.
   * @param {Object} event
   * @returns {boolean}
   */
  dispatch(event) {
    let state = this.currentState;
    while (state) {
      if (state.handle(event, this.ctx)) return true;
      state = state.parent;
    }
    return false;
  }

  getPathString(separator = " ➔ ") {
    if (!this.currentState) return "NONE";
    return separator === " ➔ " ? this.currentState.pathString : this.currentState.getPath().join(separator);
  }

  isInState(stateName) {
    let s = this.currentState;
    while (s) {
      if (s.name === stateName) return true;
      s = s.parent;
    }
    return false;
  }

  getDebugInfo() {
    return {
      name: this.name,
      current: this.currentState ? this.currentState.name : "NONE",
      path: this.getPathString(),
      depth: this.currentState ? this.currentState.depth : 0,
      transitionCount: this.transitionCount,
      lastTransition: this.lastTransition
    };
  }
}

// ============================================================================
// DUAL LIFECYCLES: MacroHSM (Match Tempo & Jungle Clear)
// ============================================================================

export const MacroStates = {};
MacroStates.MatchTempo = new State("MatchTempo");
MacroStates.PreMatch = new State("PreMatch", MacroStates.MatchTempo);
MacroStates.EarlyGame = new State("EarlyGame", MacroStates.MatchTempo);
MacroStates.ScanningAnchor = new State("ScanningAnchor", MacroStates.EarlyGame);
MacroStates.CrossMapPath = new State("CrossMapPath", MacroStates.EarlyGame);
MacroStates.Vertical3Camp = new State("Vertical3Camp", MacroStates.EarlyGame);
MacroStates.InvadePath = new State("InvadePath", MacroStates.EarlyGame);
MacroStates.MidGame = new State("MidGame", MacroStates.MatchTempo);

// ============================================================================
// DUAL LIFECYCLES: TacticalThreatHSM (Per-Hero Proximity, Wave Staging & Flank)
// ============================================================================

export const TacticalStates = {};
TacticalStates.Tactical = new State("Tactical");
TacticalStates.Dormant = new State("Dormant", TacticalStates.Tactical);
TacticalStates.Approaching = new State("Approaching", TacticalStates.Tactical);
TacticalStates.OpenField = new State("OpenField", TacticalStates.Approaching);
TacticalStates.TurretDefense = new State("TurretDefense", TacticalStates.Approaching);
TacticalStates.StagedDive = new State("StagedDive", TacticalStates.TurretDefense);
TacticalStates.UnstagedZoning = new State("UnstagedZoning", TacticalStates.TurretDefense);
TacticalStates.FlankCutoff = new State("FlankCutoff", TacticalStates.Approaching);
