# Architecture & Design: Minimap Replay & Persistent Draft System

**Author:** ENI & LO  
**Scope:** Telemetry persistence, `/draft.json` decoupling, end-of-match state preservation, and the Minimap Replay Engine.

---

## 1. Problem Statement: The `{}` Flash & Disappearing Draft

### The Bug
During match transitions, before `cppport` attaches, or when the game client restarts, `serve.py` served its default `LATEST = "{}"`.
In `map.html`, `updateDraftView(d)` had the check:
```javascript
const drafting = !d.bm && Array.isArray(d.draft) && d.draft.length > 0;
if (!drafting) {
    view.classList.add("hidden");
    return;
}
```
Whenever `map.json` returned `{}` (or as soon as the match started loading with `bm: 1`), `d.draft` was missing, causing `updateDraftView` to immediately hide the draft modal. All enemy spell selections, hero picks, and lane assignments vanished before players could study them. Furthermore, when the match ended, the canvas was wiped blank rather than preserving the final game state.

---

## 2. Implemented Solution (Decoupled State & Sticky Draft)

### 2.1 Backend (`serve.py`)
1. **Dedicated `/draft.json` Endpoint:**
   - `LATEST_DRAFT = "{}"` is maintained independently of `LATEST`.
   - When any frame containing `"draft":` is streamed from `cppport`, it is stored in `LATEST_DRAFT`.
   - Normal in-game frames (`bm: 1`) and empty ticks (`{}`) **never overwrite `LATEST_DRAFT`**.
2. **End-of-Game Freezing:**
   - When a session finishes or the game process exits, `serve.py` preserves `LATEST` and `LATEST_DRAFT` rather than wiping them.

### 2.2 Frontend (`map.html`)
1. **Interactive `[draft]` HUD Button:**
   - Added `#b_draft` button in the top bar (next to `PiP` and `settings`).
   - Toggles `#draftView` on demand at any point before, during, or after a match.
   - Includes a clean `[close]` button inside the header `#dvHead`.
2. **Multi-Tier Fallback Storage:**
   - On frame receipt, `d.draft` is saved to memory (`savedDraft`) and `localStorage.setItem("last_draft", ...)`.
   - If opened when memory is cold, it automatically fetches `/draft.json`.
3. **Canvas State Freezing:**
   - `tick()` stores `lastValidData`. If network frames temporarily drop or return `{}`, the canvas continues displaying the last valid hero/jungle snapshot until a new session begins.

---

## 3. The Minimap Replay Engine Blueprint

### 3.1 Overview
The replay system records the external telemetry stream into a compact `.mreplay` or `.jsonl` file, allowing post-match scrubbing, macro rotation analysis, and teamfight breakdown directly inside `map.html`.

### 3.2 Data Volume & Bandwidth
* **Capture Cadence:** 5 Hz to 10 Hz (every 100–200ms).
* **Frame Payload:** `{ "gt": 142.4, "self": {...}, "heroes": [...], "jungle": [...] }` (~350–500 bytes per frame).
* **15-Minute Match:** ~4,500 frames ≈ **2.2 MB raw JSON** (under **400 KB gzipped**).

### 3.3 Replay File Specification (`.mreplay`)
```json
{
  "version": 1,
  "matchId": "20260925_214800_Edith",
  "recordedAt": "2026-09-25T21:48:32Z",
  "selfCamp": 1,
  "draft": [ ...10 player objects with heroes, spells, ranks... ],
  "duration": 924.5,
  "frames": [
    { "gt": 0.0, "self": { "p": [36.0, 0, 1.9], "hp": 457 }, "heroes": [ ... ], "jungle": [ ... ] },
    { "gt": 0.1, "self": { "p": [36.1, 0, 2.0], "hp": 457 }, "heroes": [ ... ], "jungle": [ ... ] }
  ]
}
```

### 3.4 Replay Player Controls (`map.html`)
When replay mode is engaged, live polling is paused and the replay scrubber bar appears:
* **Timeline Slider:** `<input type="range" min="0" max="totalFrames">` displaying current `gt` (`04:15 / 15:24`). Dragging scrubs instantly to that timestamp.
* **Playback Controls:** Play / Pause, Step Backward (`-1s` / `-1 frame`), Step Forward (`+1s` / `+1 frame`).
* **Speed Selector:** `0.5x`, `1x`, `2x`, `4x`, `8x`.
* **Perspective Modes:**
  - **Player Vision (Fog ON):** Enemies with `fog: 1` are dimmed or hidden, recreating exact match vision to evaluate player map awareness.
  - **Oracle / God View (Fog OFF):** All 10 entities rendered continuously, revealing enemy jungler pathing and bush traps.
* **Key Event Markers:** Auto-detected death timestamps and Lord/Turtle takedowns rendered as colored pips on the timeline.
