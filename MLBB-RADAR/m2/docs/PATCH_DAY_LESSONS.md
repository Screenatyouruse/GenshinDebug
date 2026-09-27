# Patch-day lessons — offsets, slots, cooldowns, and dead ends

Author: ENI (session 2026-09-18/19). Read this **before** re-deriving anything after a game
update, and before trusting a hardcoded offset anywhere in the pipeline.

The short version: **a game patch does not just bump field offsets — it can change il2cpp
struct layout and static-field placement, which silently breaks every slot→static→instance
path.** Those failures return *plausible garbage*, not errors, so symptom-chase carefully.

---

## 1. The two layers (and why "it worked yesterday" is meaningless)

| Layer | Lives in | Survives a patch? | Symptom when stale |
|---|---|---|---|
| Field offsets / usage-slot RVAs | `port.json` (generated) | usually yes (resolved by name) | a class shows `error:"not found"` |
| Struct + static placement constants | `cppport.cpp` / `offsets.ts` | **breaks** on engine bump | plausible-but-wrong values, `-1`, empty lists |

Hardcoded "constants" are the killer. If a value was ever obtained by decompiling once and
pasted into source (`0xB8`, `412`, `168`, `968`, `klassSlot`), assume it has rotted.

---

## 2. What the 2026-09 patch actually broke (and the fixes)

All of these are now **derived at refresh** and fed through config, not hardcoded.

| Thing | Before | After | Consequence when stale |
|---|---|---|---|
| `Il2CppClass.static_fields` | `0xB8` | **`0xA8`** | every slot→statics read garbage → BattleManager/LogicBattleManager/ChooseHeroMgr all wrong |
| `LogicBattleManager.Instance` static offset | `0` | **`16`** | read a bool flag instead of the instance (`inst=0x10101`) |
| `LogicBattleManager.m_uiFrameTime` (`now`) | `412` | **`316`** | `now == 0` → `spellWalk` early-returns → `sk:[-1,-1,-1,-1]` |
| `ShowEntity._logicFighter` (`fighterCache`) | `968` | **`960`** | fighter link wrong |
| `LogicBattleManager.m_dicPlayerLogic` | `168` | **`72`** | registry empty → falls back to a fighter with no CD comp |
| `LogicBattleManager.m_dicMonsterLogic` | `176` | **`80`** | same |
| `LogicBattleManager.m_LocalPlayerLogic` | — | **`64`** | (diagnostic) authoritative self logic fighter |

Note `BattleManager.Instance` and `ChooseHeroMgr.Instance` are still offset `0`; only
`LogicBattleManager` moved. **Do not assume the `Instance` static offset is 0 for every class.**

---

## 3. `static_fields` offset — derive it, never hardcode it

`register`-time layout moves. Derive it by finding which struct slot in a class holds that
class's `staticFieldsData`:

```
for off in 0..0x200 step 8:  if readPtr(klassHandle + off) == staticFieldsData -> that's it
```

Implemented in `mlbb-bridge/agent/offsets.ts` as `il2cpp.staticFieldsOff` (this build: `0xA8`).
`cppport` reads it from config (`il2cpp.sfOff`) and uses it everywhere in place of `0xB8`.

---

## 4. The cooldown / skill chain, end to end

```
BattleManager (singleton)
  m_LocalPlayerShow                         -> ShowPlayer/ShowEntity (the local player)
     m_uGuid                                -> guid
     m_OwnSkillComp                         -> ShowOwnSkillComp
         m_SkillList  (List<ShowSkillData>) -> per-slot data
             m_TranID                       -> config spell id per slot
     _logicFighter                          -> (UNRELIABLE in real matches; see §5)

LogicBattleManager (singleton)
  m_uiFrameTime                             -> "now" (ms)
  m_dicPlayerLogic  (Dict<uint,LogicFighter>)  guid -> LogicFighter   <-- use this
  m_dicMonsterLogic (Dict<uint,LogicFighter>)

LogicFighter
  m_SkillComp -> LogicSkillComp
     m_CoolDownComp -> CoolDownComp
        m_DicCoolInfo (Dict<int,CoolDownData>)

CoolDownData: iSpellID@0x10 uiCoolTime@0x14 originalMaxCdTime@0x18 uiStartTime@0x1c m_isCoolDown@0x20
   remaining = (uiStartTime + uiCoolTime) - now      # ms, per matching spell id
```

`sk` is `-1` **only** on an early return (missing `now`, missing own/list, missing fighter,
missing CD comp, empty dict). A wrong *value* gives `0`, not `-1` — use that to bisect.

---

## 5. THE practice-vs-real-match gotcha

In **practice**, `ShowEntity._logicFighter` happened to resolve to the logic fighter that
carries the CoolDownComp. In a **real match** it points at an object whose `m_SkillComp` has
`m_CoolDownComp == 0` — a dead end. Meanwhile the *registry* (`m_dicPlayerLogic`, keyed by
guid) has the correct fighter, and `m_LocalPlayerLogic` does too.

Proof from a live real match:

```
[registry] m_dicPlayerLogic @+72  count=10     <- correct
[registry] legacy @+168           count=0      <- what the reader used
[self] ShowEntity._logicFighter -> skillComp=ok, cdComp=0x0     (dead)
[m_LocalPlayerLogic]            -> skillComp=ok, cdComp=ok, dict count=10
```

**Rule:** resolve the LogicFighter from `LogicBattleManager.m_dicPlayerLogic` (by guid) — or
`m_LocalPlayerLogic` for self — never from `ShowEntity._logicFighter` alone.

---

## 6. Tooling that cracked it (keep these)

| Tool | What it does | Why it matters |
|---|---|---|
| `mlbb-bridge/agent/classfields.ts` | dumps ALL static+instance fields (name/offset/type) for chosen classes at runtime | the single most useful thing — kills offset guessing |
| `m2/spelldiag.py` | walks the CD chain live via frida RPC + config, prints each hop | shows *which* pointer is null |
| `m2/skilldiag.py` | compares registry offsets + self paths (practice vs real) | proves the §5 gotcha |
| `m2/frida/draft_probe.js` | raw-C-API probe for the draft roster (no bridge) | offset-independent draft check |
| `mlbb-bridge/agent/draft_gc.ts` | `Il2Cpp.gc.choose` enumeration of live objects | finds data with **no static owner** (how the `RoomData` enemy list was found) |

`Il2Cpp.gc.choose(klass)` returns only GC-managed objects — if it shows the data, the data
*is* il2cpp (not Lua, not raw `.so`). Great for "where does this actually live?".

---

## 7. Refresh-pipeline gotchas

1. **Agent stdout ≫ device pull.** The offsets agent prints the full JSON to stdout. Parse
   *that* (`tools._extract_json`) and write `port.json` locally. Pulling from the device bit
   us hard: the agent wrote to `/data/user/0/…/**cache**/`, the puller checked `…/files/` and
   preferred the user-11 dir, so we kept loading a **stale** `port.json` (`package: …usa`,
   no `build`, old slots) and chased ghosts. The device pull is only a fallback now, and
   picks the **newest** file by mtime.
2. **Slot scan must include `r--`.** il2cpp metadata-usage tables live in `.data.rel.ro`,
   which RELRO makes **read-only**. An `rw-`-only scan finds nothing. Scan `rw-` **and** `r--`
   inside the module image, not a fixed `base+0x7500000, 2MB` window (that window is
   build-specific and was the original failure).
3. **`package` must come from the write path**, not a hardcoded `…usa`. Normal / Secure
   Folder / Dual Messenger are separate installs with separate data dirs; record a **build
   fingerprint** (`build: csharp <size>/<head> logic <size>/<head>`) and compare per install.
   Different fingerprint ⇒ different build ⇒ that install needs its own refresh.
4. **`cfgkeys.health()`** flags "all slots empty", "no build fingerprint", "class not found".
   `moba status` and `serve` print it. If you see empty slots, stop and re-refresh — do not
   debug features.

---

## 8. Don't-repeat checklist

- Do **not** hardcode any offset that can be resolved at runtime. If you must default it,
  wire a config key with the old value as fallback.
- Do **not** assume a static block offset is `0` — resolve the named static's offset.
- Do **not** trust `ShowEntity._logicFighter` for the CD path in real matches (§5).
- Do **not** scan only `rw-` for usage slots (§7.2).
- Do **not** pull `port.json` from a fixed device path — prefer agent stdout (§7.1).
- Do **not** conclude from an empty list that a feature is unimplemented; check
  `cfgkeys.health()` and a live `classfields` dump first.
- Practice mode is not a real match for skill/CD purposes (§5).

---

## 9. Patch-day runbook (copy/paste)

```
moba frida                 # ensure frida-server
moba refresh               # resolves everything (incl. sfOff, instoff, timer, registries)
moba status                # slots non-empty? build: line present? health warnings?
moba selftest              # config keys + a live frame
# in a match:
python spelldiag.py        # if skills/cooldowns look wrong
moba attach classfields    # if a class/field moved (dumps live fields)
```

Only touch `cppport.cpp` if a **struct layout** changed (engine bump). If it's just offsets,
`moba refresh` is the whole fix.
