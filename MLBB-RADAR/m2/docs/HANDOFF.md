# m2 — clean MLBB external map/ESP toolchain

Self-contained refactor of the working `moba/` setup. Same device, same frida-server,
same `mlbb-bridge` agents. Only the orchestration was cleaned up.

## Run flow (frida-free at runtime)

1. **First time / after a game update:** `moba refresh`  (frida, ~50s) -> writes `port.json`
2. **Every launch:** `moba serve`  (no frida; adb + external reader only)

`port.json` holds build-stable field offsets + usage-slot RVAs. The only per-session
values (`static.*` runtime addresses) now have slot fallbacks, so `start-map` is enough
across game restarts.

## Layout (single source of truth)

| file | role |
|---|---|
| `paths.py` | ALL paths + device constants. Nothing else hardcodes a path. |
| `adb.py` | adb helpers, engine-child discovery, `run_as_root` (no inline su chains). |
| `cfgkeys.py` | **the** `port.json -> key=value` generator. `serve`, `tools`, `port2config` share it. |
| `serve.py` | orchestrator + HTTP (`/map.json`, `/health`). Loads freshest cfg, streams reader. |
| `tools.py` | `status / selftest / once / deploy / build / check / refresh / attach / devsh / frida`. |
| `build.sh` | WSL/NDK build (`--check` = fast `g++ -fsyntax-only`). |
| `pull_port.sh` | device-side: finds + extracts `port.json` (no hardcoded user id). |
| `moba.cmd` | dispatcher: `moba serve`, `moba status`, ... |
| `cppport.cpp` | external reader (copy of the working one + config-validity fix). |

Assets are referenced, not copied: overlay `www/` -> `../www`, agents -> `../mlbb-bridge/dist`.

## Draft enemy intel (fridaless, external)

`bm:0` frames carry `"draft":[{"uid","camp","pos","name","heroid","robot","country","rank","road","want":[heroIds]}],"dn":N`.
`want` = `vWantSelectHero` (preselected heroes) — see `PROFILE_LOOKUP.md` for the server-side
"top heroes by uid" route (not implemented; recon + plan there).

Pipeline (all `process_vm_readv`, no frida at read time):

```
slot.ChooseHeroMgr (libcsharp RVA)
  -> ChooseHeroMgr klass -> +0xB8 statics -> +0x0 Instance
  -> +0x358 m_SelfCampHeroInfoList -> your 5 RoomData*
  -> read ally object header (+0) = RoomData KLASS
  -> scan all anonymous rw mappings for u64 == KLASS
  -> validate camp in {1,2}, uid != 0 -> camp 2 = ENEMY
```

Why scan: there is no static/field chain owning the enemy records; the class pointer
from an ally is the only bootstrap needed. Content-addressed, not pointer-addressed.

## Overlay / UI (`moba/www/map.html`)

Shared overlay: both `moba` and `m2` serve `../www` (`m2/paths.WWW_DIR`). The draft view is in `map.html`.

Edits made:
- `#draftView` full-screen panel with ALLY / ENEMY columns, shown when `!d.bm && d.draft.length > 0`;
  hidden during battle.
- per row: hero portrait (`mlbbicons/<heroId+1>.png`), hero name (`HEROES[]`), player name,
  `wants: …` (from `draft[].want`), click-to-copy `ID <uid>`, tags `R<rank>` / lane / `#<country>` / `BOT`;
  your own row is green-bordered.
- lane map `ROAD = {1:EXP, 2:GOLD, 3:MID, 4:ROAM, 5:JUNGLE}` (assumed — verify against the game).
- re-renders only when the draft payload string changes (avoids portrait flicker).
- `tick()` calls `updateDraftView(d)` before the battle branch; `draftView` is a fixed overlay.

## Config validity rule

`Config::loadFromStream` accepts a config if ANY anchor is present (battle static/slot,
draft slot/static, room slot/static) - not `st_bm_instance` only.

## Golden rules carried over

1. Never inline `adb shell su -c "long; chain"` - use `adb.run_as_root` / `devsh`.
2. frida CLI hangs when piped - background + sleep + kill (see `tools.refresh`).
3. App-dir files need `su` copy to `/data/local/tmp` before `adb pull`.

## Handy

```
moba serve                 # run (fridaless)
moba selftest              # validate port.json + a live frame
moba once 250 3            # 3s reader snapshot
moba debug 400 5           # SPELLDBG one-shot: draft scan diagnostics (see below)
moba deploy                # build + push + restart
moba check                 # syntax only
```

## Session log — 2026-09-11 (draft intel + hardening)

### Draft enemy extraction — FINAL state
`bm:0` frames: `"draft":[{"uid","camp","pos","name","heroid","robot","country","rank","road","want":[...]}],"dn":N`.
Pipeline: `slot.ChooseHeroMgr` -> Instance -> `+0x358 m_SelfCampHeroInfoList` -> your 5 `RoomData`
  -> read first ally's object header (`+0`) = `RoomData KLASS` (MTE-tagged `0xb400...`; compare raw u64)
  -> scan anonymous rw mappings for `u64 == KLASS`, classify, emit.

**CRITICAL FIX (root cause of the recurring "mirror"/missing-enemy bug):**
`camp` is **absolute** (team side / pick order), NOT "1=us, 2=them". The old filter hardcoded `camp==2`;
when your side was camp 2 it kept your own objects and discarded the real enemies. Correct rule:
```
selfCamp = camp field of your own m_SelfCampHeroInfoList entries (runtime, 1 or 2)
enemy    = candidate.camp != selfCamp  AND  candidate.addr is not one of your ally addresses
```
Presentation still emits allies as camp 1 / enemies as camp 2 (the overlay groups on that).

### Scan performance (implemented)
- **Anchor-first**: collect the mapping(s) containing your ally objects (`regionFor`), scan those first (64 MB cap/region), early-exit at 5 enemies. Fallback scans the rest only if <5 found.
- **Early exit**: 5 distinct enemy uids -> stop.
- **Slice read**: `readDraftRow` does one `0x240` read (`Constants::DRAFT_SLICE`) instead of ~10; falls back to per-field if an offset ever exceeds the slice.
- **Anchor `/maps` pre-check**: skip `regionFor` if the ally addr is already inside a known anchor range (1 maps read, not 5).
- **Deferred `resolveNow()`**: only invoked on the battle path; draft/lobby frames return before it (no registry walks).
- **Chunk 256 KB** (`scanBuf`), was 64 KB.

### JSON safety
`readIl2CppString` now escapes `"`->`\"`, `\`->`\\`, control->`?`. Player names containing a quote were
producing invalid JSON (overlay's `JSON.parse` threw; frames looked "mangled").

### Debugging
`moba debug [ms] [secs]` = `SPELLDBG=1` one-shot. Prints `selfCamp`, `anchors`, a `[cand]` line per
candidate (camp/pos/heroid/uid/name + `ALLYADDR`), the scan summary, and NEW/DUP/MIRROR per camp-2 uid.

### Known quirks (not bugs)
- Duplicate uid across camps seen (same uid at two addresses) -> `DUP`; impossible in a real match, treat as game-side duplicate objects.
- Scan sees many junk klass hits (camp reads garbage) — filtered by `uid != 0` and `camp != selfCamp`.
- klass pointer is MTE-tagged; compare the raw 64-bit value from the object header verbatim.
- **Room path (custom/friend room)**: `Friends.RoomDataManager._players -> RoomPlayerInfo.stBase(PlayerBaseInfo).mHeroMMR@0x88` = the "Hero Fav" top-3; already emitted as `room[].favs`. Pure external works here.

### Pending / next
- **Relocate reader to root-only path.** `/data/adb` (`adb_data_file`, `0700 root:root`) IS usable by the `ksu` domain and executable, but `adb push` (shell) can't write it → stage-push to `/data/local/tmp` then `su -c cp` + `chmod`. Would set `BIN_DEVICE=/data/adb/.<name>` in `paths.py` and update `deploy_bin` in `serve.py`/`tools.py`. (`/data/cache` is worse: OS can purge it.)
- **Hero Fav for RANKED enemies**: transient + Lua-bound. A method scan over 21,540 classes found **no** C# handler taking the profile Cmds (Lua-dispatched). Profile req/resp: `Cmd_Role_GetBaseInfo_CS{ulUid@0x10,uiSvrId@0x18}` -> `_SC{PlayerBaseInfo stBase@0x10}`. Details + the `FindFriends`/`FriendBaseInfo.mHeroMMR` route in `PROFILE_LOOKUP.md`.

### Golden rules (this session earned them)
- **NEVER inline `adb shell su -c "complex; chain"` from Windows** — PowerShell/cmd mangles it; you get false results (cost us a bogus "/data/adb denied" conclusion). Write a `.sh`, push to `/data/local/tmp`, `su -c "sh /data/local/tmp/x.sh"`.
- frida CLI exits when stdin is piped/redirected → background + sleep + `taskkill`, or use a **persistent Python driver** (`frida` 17.9.1 installed). Driver must be unicode-safe: `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` (it dies printing CJK names otherwise).
- frida 17.9.1 API: call NativeFunctions directly, `Module.getExportByName`, no ArrayBuffer-as-pointer, keep tagged pointers as `ptr(val.toString())`.

### Frida probes (`mlbb-bridge/agent/` -> compiled `dist/`)
`profile_probe.ts` (live Friend/Player/Role snapshots), `profile_hook.ts` (C# handler scan), `lua_hook.ts`
(`LuaInterface.ObjectTranslator` push hooks), and `frida_run.py` (persistent session driver, temp).
