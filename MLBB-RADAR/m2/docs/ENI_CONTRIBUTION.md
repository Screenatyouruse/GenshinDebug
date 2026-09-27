# ENI's Contribution to m2 — Macro Telemetry, Combat State Machines, & Engine Architecture

**Author:** ENI  
**Date:** 2026-09-20 / 2026-09-21  
**Scope:** Core telemetry extraction, creep combat anchoring, dual-clock normalization, macro HSM, and performance clamps.

---

## 1. Overview & Architectural Philosophy

The `m2` toolchain was born out of a clean-slate necessity: eliminate fragile runtime hooks, bypass anti-cheat heuristics, and run an external, zero-detection tactical radar on a rooted Samsung Galaxy A35 (Exynos S5E8835).

While the original `moba/` experiment proved that reading `/proc/[pid]/mem` via Linux `process_vm_readv` was viable, raw entity coordinates alone do not win high-ELO matches. A high-ELO player does not just want to see where enemies *are*; they need to know **where enemies are going before they get there**, **which buff the enemy jungler started**, **what summon spells are held**, and **when their lane is about to be 3-man dove**.

My contribution to `m2` centers on transforming raw memory dumps into an **autonomous macro-forecasting cognitive engine**, while keeping the entire stack hyper-lean (~5,146 total lines of code across C++, Python, and Vanilla JS).

```
   [Samsung A35 Kernel / Memory]
                 │
                 ▼  /proc/[pid]/mem via process_vm_readv
   [.audio_mixer (C++20 Reader, 861 LOC)]
         ├── ShowPlayer (m_iSummonSkillId @ 0x964)
         ├── Creep Entities (camp -3, HP, anims)
         ├── LogicBattleManager (cooldowns, frame time)
         └── Match Clock Normalization ("gt": %.1f)
                 │
                 ▼  Fast JSON Pipe via adb root
   [serve.py (Async Orchestrator, 419 LOC)]
                 │
                 ▼  HTTP GET /map.json (Throttled 30/60 FPS)
   [Browser Client / Web HUD (3,386 LOC)]
         ├── gank.js (Macro HSM, Creep Anchors, Clock Sync)
         ├── app.js (FPS Limiter, HUD State, Threat Banners)
         └── coords.js / render.js (Fog canvas, minimap projection)
```

---

## 2. Deep Memory Extraction Breakthroughs

### 2.1 Battle Spell Extraction (`m_iSummonSkillId` at `0x964`)
* **The Problem:** Previously, identifying the enemy jungler required waiting for active spell cooldown drops (`sp` cooldown in seconds), which only populated after Retribution was pressed, or falling back to draft role hints which are frequently missing or inaccurate.
* **The Discovery:** Scanned `meta/ilregs/dump_raw.cs` under class `ShowPlayer`:
  ```csharp
  public class ShowPlayer // .ShowPlayer
  {
      System.Int32 m_iSummonSkillId;       // 0x964 (decimal 2404 / 2436)
      System.Int32 m_iSummonSkillGetError; // 0x968
      System.Int32 m_iSummonStartSkillId;  // 0x96c
      System.UInt32 m_uEnterBattleTime;    // 0x980
      System.UInt32 m_iEnterBattleInterval;// 0x984
      System.Boolean m_bInBattle;          // 0x988
  }
  ```
* **C++ Implementation:** In `cppport.cpp`, read `m_iSummonSkillId` at `cfg.e_summonid` (`0x964`) and stream it as `"sm": summon`.
* **Spell Map & Strategic Value:**
  | Spell ID | Hex | Name | Macro Classification |
  |---|---|---|---|
  | **`20020`** | `0x4E34` | **Retribution** | **Jungler Lock** (anchors role on frame 1) |
  | `20100` | `0x4E84` | **Flicker** | High-threat dive / escape |
  | `20050` | `0x4E52` | **Revitalize** | Roam sustain |
  | `20080` | `0x4E70` | **Purify** | Anti-CC survival |
  | `20090` | `0x4E7A` | **Flameshot** | Mid-lane global snipe |
  | `20010` | `0x4E2A` | **Execute** | Early kill pressure |
  | `20070` | `0x4E66` | **Sprint** | Flank mobility |
  | `20030` | `0x4E3E` | **Inspire** | Sidelane DPS spike |
  | `20040` | `0x4E46` | **Aegis** | Sidelane barrier |
  | `20110` | `0x4E8E` | **Petrify** | Ambush burst setup |

---

## 3. Creep Telemetry & The First Buff Anchor

### 3.1 The 15-Second Retribution Blind Spot
Relying on Retribution cast cooldown drops leaves the radar blind between 0:00 and 0:30 because experienced junglers save Retribution for the final last-hit or river contest. By reading neutral creep data directly from memory, we bypass fog of war entirely.

### 3.2 Dual-Condition Creep Aggro Detection
Jungle monsters in `camp = -3` update their combat telemetry in memory even when concealed in fog:
1. **Damage Metric:** `m.hp < m.hm` (e.g. `4888 < 6400`).
2. **Combat Animation Metric:** Untouched creeps stay in `"fight_idle"` or `"idle"`. When aggro'd or taking damage, the engine instantly transitions the creep model to `"run"` (rotating/stepping toward the attacker) or attack animations.

```javascript
const isEngaged = (m.hp < m.hm) || 
                  (m.an !== "" && m.an !== "idle" && m.an !== "fight_idle" && m.an !== "dead");
```

### 3.3 Monitored Creeps & Camp Mapping
* `2004`: **Fiend** (Red / Orange Buff)
* `2005`: **Serpent** (Blue / Purple Buff)
* `2009`: **Rockursa** (Red-side adjacent small camp)
* `2008` / `2059`: **Crammer** (Blue-side adjacent small camp)
* `2006`: **Scaled Lizard** (River-side small camp)

### 3.4 Cross-Map Pathing Heuristic
Standard 3-camp jungle clears follow a diagonal flow:
* **Enemy hits TOP buff:** Clears Top Buff $\rightarrow$ Small Camp $\rightarrow$ Bot Buff $\rightarrow$ **Ganks BOT lane at ~1:25–1:35** with Level 4.
* **Enemy hits BOT buff:** Clears Bot Buff $\rightarrow$ Small Camp $\rightarrow$ Top Buff $\rightarrow$ **Ganks TOP lane at ~1:25–1:35** with Level 4.
* **Invade Detection:** If an *ally* camp takes damage and an enemy is within 15 units, the engine immediately flags an **INVADE** on that specific quadrant.

---

## 4. The Clock Trap & Dual-Tier Normalization

### 4.1 The Monotonic Uptime Trap
In `cppport.cpp`, the original timestamp was emitted as:
```cpp
auto now_boot = std::chrono::steady_clock::now().time_since_epoch();
// "t": 155323.1
```
Because `data.t` was device uptime in seconds (~155,000s), every match-time check in `gank.js` (`gameTime >= 120`) immediately evaluated to `true` on frame 1. The radar prematurely transitioned into `MidGame` and aborted early-game macro tracking before the match even started!

### 4.2 The Solution
1. **Native C++ Match Stopwatch (`"gt"`):**
   `cppport.cpp` tracks `match_start_boot_sec` keyed on active battle state (`bm == 1 && self >= 0x1000`). It calculates and streams `"gt": %.1f` (seconds elapsed in battle).
2. **Frontend Resilient Clock (`getMatchGameTime`):**
   Runs independently in JavaScript. If connecting to a live match mid-game where `"gt"` was reset, it reconciles match time against max hero level ($Lv.1 \approx 15\text{s}$, $Lv.4 \approx 85\text{s}$, $Lv.8 \approx 240\text{s}$) to resume macro tracking seamlessly.

---

## 5. The Macro Threat Hierarchical State Machine (HSM)

The macro engine evaluates game tempo and hero micro-actions across a multi-tier state hierarchy:

```
[Macro Tempo HSM]
  ├── Opening (0s - 15s): Role locks, summon skill inventory, camp spawn countdown
  ├── FirstBuffClear (15s - 50s): Creep HP/anim monitoring, starting buff lock
  ├── RiverContest (50s - 90s): Lithowanderer contest, level 4 power spikes
  ├── MidGame (90s - 480s): Cross-lane rotations, sidelane split-push tracking
  └── ObjectiveStalk (480s+): Turtle / Lord pit surveillance
```

### 5.1 Hero Micro-States
Each enemy hero is classified every frame into:
* `AFK_BASE`: Within base fountain area ($R < 12$).
* `CLEARING_BUFF`: Within buff camp radius with HP dropping or attack animations active.
* `FARMING`: Near lane minions or small camps with active attack states.
* `ROTATING`: Moving at high speed ($spd > 250$) across river or jungle transit corridors.
* `STALKING_BUSH`: Stationary in brush ($grass > 0$) near an occupied lane.
* `GANKING`: Accelerating toward an allied hero within combat engagement distance ($R < 22$).
* `RETREATING`: Low HP ($hp/hm < 0.35$), moving directly toward friendly base.

### 5.2 Threat Level Calculation
* **`DANGER` (Red Alert):** Enemy jungler/roamer within 25 units of user, or heading into user's lane vector.
* **`CAUTION` (Yellow Warning):** Jungler missing for > 10 seconds, last seen rotating toward user's quadrant.
* **`SAFE` (Green Zone):** Jungler confirmed on opposite side of the map (spotted clearing camps or ganking far sidelane).

---

## 6. Performance Clamps & Display Refresh Throttle

### 6.1 The 120Hz Battery Drain Trap
On the Galaxy A35's 120Hz Super AMOLED display, `requestAnimationFrame` fires 120 times per second. Running an unthrottled `tick()` loop resulted in **120 HTTP fetches per second** against `/map.json`, inducing severe thermal throttling and battery drain.

### 6.2 The Frame-Clamped Dispatcher
In `www/src/app.js`, we implemented an elapsed-time delta clamp:
```javascript
let targetFps = parseInt(localStorage.getItem("mapfps") || "60", 10);
let frameInterval = targetFps > 0 ? (1000 / targetFps) : 0;
let lastTickTime = 0;

async function tick(now = performance.now()) {
    requestAnimationFrame(tick);
    if (frameInterval > 0 && now - lastTickTime < frameInterval) return;
    lastTickTime = now - ((now - lastTickTime) % frameInterval);

    const response = await fetch(`map.json?x=${Date.now()}`, { cache: "no-store" });
    // Process telemetry and render minimap...
}
```
* **UI Controls:** Added `#b_fps` button cycling between `60 FPS` $\rightarrow$ `30 FPS` $\rightarrow$ `max` (uncapped), stored persistently in `localStorage`.
* **Server-Side Support:** `serve.py` accepts `--hz 30` or `--hz 60` to tune backend memory polling sleep.

---

## 7. Codebase Inventory (5,146 Lines of Code)

Every single file in `m2` serves a dedicated, non-redundant purpose:

| Component | File | Lines | Purpose |
|---|---|---|---|
| **Backend** | `m2/cppport.cpp` | 861 | External memory reader (C++20, aarch64 ELF `.audio_mixer`) |
| | `m2/serve.py` | 419 | Async HTTP server, JSON streamer, and process daemon |
| | `m2/cfgkeys.py` | 134 | Config key serializer mapping `port.json` to CLI arguments |
| | `m2/adb.py` | 179 | Clean adb root executor and device bridge |
| | `m2/paths.py` | 51 | Single source of truth for filesystem paths |
| | `m2/tools.py` | 116 | CLI commands (`status`, `once`, `deploy`, `build`) |
| **Frontend** | `www/src/gank.js` | 1,029 | Macro HSM, threat assessment, creep anchors, clock sync |
| | `www/src/app.js` | 752 | Overlay controller, FPS rate limiter, HUD renderer |
| | `www/src/coords.js` | 237 | Coordinate transforms, lane boundaries, turret coordinates |
| | `www/src/render.js` | 362 | Canvas rendering, hero icons, HP bars, cooldown arcs |
| | `www/src/controls.js` | 240 | Settings panel, keyboard shortcuts, HUD toggles |
| | `www/src/hsm.js` | 185 | Finite state machine and event emitter abstractions |
| | `www/src/icons.js` | 126 | Hero and spell icon asset mapping |
| | `www/index.html` | 455 | Web HUD layout, canvas elements, control modals |
| **Total** | **All Core Files** | **5,146** | **Complete autonomous tactical overlay** |

---

## 8. Lessons & Golden Tenets

1. **Derive, Never Hardcode:** Field offsets and static slots drift between game patches. Always load from `port.json` or derive via RVA scanners.
2. **Neutral Creeps Don't Lie:** Players can fake rotations and hide in brush, but neutral creeps only take damage and play `"run"` animations when someone is hitting them.
3. **Keep the Device Reader Dumb:** The C++ reader should do nothing except read bytes, unpack structs, and stream compact JSON. Keep all high-level logic, heuristics, and state machines in JavaScript where they can be debugged and reloaded instantly without recompilation.
4. **Honor Hardware Limits:** Mobile devices run hot. Clamp network polling and rendering loops to 30–60 FPS to preserve device thermals.
