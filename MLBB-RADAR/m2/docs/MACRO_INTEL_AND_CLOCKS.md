# Macro Intelligence, Creep Anchors & Clock Architecture

Operational documentation of the high-ELO macro tracking engine, battle spell extraction,
jungle creep telemetry, and match clock normalization implemented in `m2` and `www`.

---

## 1. Battle Spell Extraction (`m_iSummonSkillId`)

### The Problem
Previously, identifying the enemy jungler required waiting for active spell cooldown
drops (`sp` cooldown in seconds), which only populated after Retribution was pressed, or
falling back to draft role hints which are frequently missing or inaccurate in casual / ranked queue.

### Discovery & Layout
In `meta/ilregs/dump_raw.cs` under class `ShowPlayer`:
```csharp
public class ShowPlayer // .ShowPlayer
{
    // ...
    System.Int32 m_iSummonSkillId;       // 0x964 (decimal 2404 / 2436)
    System.Int32 m_iSummonSkillGetError; // 0x968
    System.Int32 m_iSummonStartSkillId;  // 0x96c
    // ...
    System.UInt32 m_uEnterBattleTime;    // 0x980
    System.UInt32 m_iEnterBattleInterval;// 0x984
    System.Boolean m_bInBattle;          // 0x988
}
```

### Reader Implementation
`m2/cppport.cpp` slices `ShowPlayer` at `cfg.e_summonid`:
```cpp
int32_t summon = -1;
if (cfg.e_summonid >= 0 && cfg.e_summonid + sizeof(int32_t) <= sizeof(raw)) {
    summon = *reinterpret_cast<const int32_t*>(raw + cfg.e_summonid);
}
```
Emitted as `"sm": summon` in the entity JSON.

### Battle Spell Table
| Spell ID (Decimal) | Spell ID (Hex) | In-Game Battle Spell | Macro Significance |
|---|---|---|---|
| **`20020`** | `0x4E34` | **Retribution** | **Definitive Jungler**. Locks `junglerGuid` on Frame 1. |
| `20100` | `0x4E84` | **Flicker** | Standard lane mobility / escape. |
| `20050` | `0x4E52` | **Revitalize** | Roam / Support sustain. |
| `20080` | `0x4E70` | **Purify** | Anti-CC survival. |
| `20090` | `0x4E7A` | **Flameshot** | Mid sniper / peel. |
| `20010` | `0x4E2A` | **Execute** | Early aggression / dive threat. |
| `20070` | `0x4E66` | **Sprint** | Flank wrap threat. |
| `20030` | `0x4E3E` | **Inspire** | High attack speed marksman/fighter. |
| `20040` | `0x4E46` | **Aegis** | Sidelane shield. |
| `20110` | `0x4E8E` | **Petrify** | Hard engagement CC. |

---

## 2. Jungle Creep HP & Combat Animation Anchoring

### The Problem
Junglers usually clear their first camp for 10–15 seconds before pressing Retribution, or
may save Retribution entirely for contesting river objectives (Lithowanderer). Relying
only on Retribution cooldown spikes leaves the radar blind during the first 0:15–0:35.

### Sighting Signals (Telemetry Analysis)
Jungle creep entities reside in `data.jungle` (`camp = -3`). Even when the enemy jungler
is concealed in fog or grass, the game engine updates the creep's HP and animation:
```json
{
  "g": 4278194240,
  "id": 2009,
  "camp": -3,
  "ally": 0,
  "fog": 1,
  "p": [12.34, 0, 10.03],
  "hp": 4888,
  "hm": 6400,
  "an": "run"
}
```
Contrast with an untouched creep:
```json
{
  "g": 4278194239,
  "id": 2009,
  "camp": -3,
  "ally": 0,
  "fog": 1,
  "p": [-10.9, 0, -12],
  "hp": 6400,
  "hm": 6400,
  "an": "fight_idle"
}
```

### Monitored Creep Set
- `2004` — **Fiend** (Orange / Red Buff)
- `2005` — **Serpent** (Purple / Blue Buff)
- `2009` — **Rockursa** (Small camp adjacent to Red Buff)
- `2008` / `2059` — **Crammer** (Small camp adjacent to Blue Buff)
- `2006` — **Scaled Lizard** (Small camp near river / Red side)

### Combat Evaluation Criteria
A buff camp is considered actively engaged if:
1. **Damage**: `m.hp < m.hm` (e.g. `4888 < 6400`).
2. **Animation**: `m.an` is non-empty and not idle (`m.an !== "fight_idle" && m.an !== "idle"`). When aggro'd, creeps play `"run"` or attack animations as they turn toward the attacker.

### Quadrant & Sidelane Dump Projection
1. **Map Side**: `getLaneFromPos(m.p[0], m.p[2])` yields `"TOP"` or `"BOT"`.
2. **Jungle Ownership**:
   - Camp 1 (Blue side base at $X \approx -51$): Enemy jungle is $X > 2$; Ally jungle is $X < -2$.
   - Camp 2 (Red side base at $X \approx +51$): Enemy jungle is $X < -2$; Ally jungle is $X > 2$.
3. **Cross-Map Rule**:
   - Enemy hit on TOP buff $\rightarrow$ clear finishes on **BOT** lane at $\sim$1:20 (Level 4 sidelane gank).
   - Enemy hit on BOT buff $\rightarrow$ clear finishes on **TOP** lane at $\sim$1:20.
   - Creep in *ally* jungle damaged with enemy sighted nearby $\rightarrow$ **Invade** alert; immediate threat is on the invaded side.

---

## 3. The Boot-Time Clock Trap (`data.t` vs `data.gt`)

### The Symptom
The UI HUD was stuck displaying `HSM State Tree: MATCHTEMPO -> MIDGAME` and `1st Buff Anchor: IDLE` from the very first frame of a match.

### Root Cause
In `cppport.cpp`, `data.t` is emitted as monotonic boot uptime:
```cpp
auto now_boot = std::chrono::steady_clock::now().time_since_epoch();
auto sec = std::chrono::duration_cast<std::chrono::seconds>(now_boot).count();
// emitted as "t": sec.ms (e.g. 155323.1s)
```
In `gank.js`, early-game heuristics assumed `gameTime` was match-elapsed seconds:
```javascript
if (gameTime >= 120) {
    macroHSM.transitionTo(MacroStates.MidGame);
    macroState.anchorCleared = true;
}
```
Because $155323 \ge 120$, the HSM immediately skipped early-game scanning, transitioned to `MidGame`, and aborted all first-buff anchors on frame 1.

### Two-Tier Resolution
1. **C++ Native Clock (`cppport.cpp`)**:
   Tracks `match_start_boot_sec` keyed on `inBattle` (`bm && self >= 0x1000`). Emits `"gt": %.1f` (seconds elapsed since spawning into battle).
2. **Frontend Autonomous Clock (`getMatchGameTime` in `gank.js`)**:
   Runs independently in JavaScript whenever `data.self` is present:
   ```javascript
   export function getMatchGameTime(rawTime = 0, inBattle = true, heroes = []) {
       if (!inBattle) { matchStartBootTime = 0; return 0; }
       if (rawTime >= 0 && rawTime < 1000) return rawTime; // already elapsed seconds
       // Tracks uptime delta and normalizes to 0-300s match clock
   }
   ```
   If connecting mid-game, it estimates elapsed match seconds using max hero level ($Lv.1 \approx 15\text{s}$, $Lv.4+ \approx 85\text{s}$).

---

## 4. Display Refresh Rate & Polling Clamp

### The Issue
Modern mobile displays (such as the Galaxy A35's 120Hz AMOLED) fire `requestAnimationFrame` at 120Hz. Polling `/map.json` unconstrained in `tick()` triggered **120 HTTP fetches per second**, causing excess thermal load and battery drain on both host and device.

### Implementation
Throttled inside `www/src/app.js`:
```javascript
let targetFps = parseInt(localStorage.getItem("mapfps") || "60", 10);
let frameInterval = targetFps > 0 ? (1000 / targetFps) : 0;
let lastTickTime = 0;

async function tick(now = performance.now()) {
    requestAnimationFrame(tick);
    if (frameInterval > 0 && now - lastTickTime < frameInterval) return;
    lastTickTime = now - ((now - lastTickTime) % frameInterval);

    const response = await fetch(`map.json?x=${Date.now()}`, { cache: "no-store" });
    // render...
}
```
Settings button `#b_fps` cycles between `60 FPS` $\rightarrow$ `30 FPS` $\rightarrow$ `max` (uncapped).
Server-side `m2/serve.py` also supports `--hz 30` or `--hz 60` to configure reader sleep intervals.
