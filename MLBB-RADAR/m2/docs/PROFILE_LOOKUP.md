# Profile lookup — "search user by ID → top heroes" (for target-ban)

Status: **not implemented** (local `vWantSelectHero` shortcut IS implemented — see bottom).
This file is the recon so a future session can pick it up without re-deriving anything.

## Goal
Given an enemy's `uid` (we already show it in the draft overlay, click-to-copy), fetch their
profile / **top heroes** so you can target-ban. Moonton exposes this through the game's own
protobuf messages — the same ones the profile screen uses. **No wire-protocol reverse needed**:
you invoke the game's send path and read the SC response, reusing the logged-in session.

## Message map (all `MTTDProto`, from `moba/meta/ilregs/dump_raw.cs`, ARM build)
| message | fields | purpose |
|---|---|---|
| `Cmd_Role_GetPlayerBaseInfo_CS` | `ulUid@0x10`, `uiSvrId@0x18`, `sRewardPredictId@0x20` | **lookup by uid+svr** |
| `PlayerBaseInfo` | `ulUid@0x10`, `uiSvrId@0x18`, `sName@0x20`, `uiRankLevel@0x34`, `iPVPVictoryScore@0x80`, `iPVPVictoryTimes@0x84`, **`mHeroMMR@0x88` `Dict<uint,uint>`** | response body — **mHeroMMR = hero→MMR = top heroes** |
| `Cmd_Get_HeroMMR_Component_CS` | `uiRankType@0x10`, `iHeroId@0x14`, `CmdRoleKey stRoleKey@0x18` | per-hero MMR component |
| `Cmd_Get_HeroMMR_Component_SC` | + `HeroMMRComponent stHeroMMRComponent@0x20` | response |
| `CmdRoleKey` | `iZoneId@0x10`, `iRoleUId@0x18` | target key (zone + uid) |
| `HeroMMRComponent` | `stMMRComponentNewMMR@0x10`, `stMMRComponentArenaMatch@0x18` | wrapper |
| `HeroMMRNew` | `iHighestVal@0x10`, `iCurVal@0x14`, titles @0x28/0x30, season dicts @0x38/0x40 | per-hero MMR detail |
| `RoleInfo` | `vHeroList@0x10`, `vHeroListRecent@0x20`, **`vMostUseHero@0x60`**, `iMostUseRoad@0x68`, ranks @0x40–0x74 | profile "most used heroes + lane" |
| `Cmd_Friend_FindFriends_CS` | `sName@0x10`, `ulUid@0x18` | resolve uid/name → `FriendBaseInfo` |
| `Cmd_Friend_FindFriends_SC` | `List<FriendBaseInfo> vecFriends@0x10` | response |

Related enums: `CmdId_Role_GetPlayerBaseInfo_CS/SC`, `CmdId_Friend_FindFriends_CS/SC`,
`CmdId_Get_HeroMMR_Component_CS/SC` (in the CmdId tables ~lines 281485/281801/282265).

Note: `CmdRoleKey` uses **zoneId**, `GetPlayerBaseInfo_CS` uses **svrId**. The draft `RoomData`
carries `uiZoneId@0x60` and `uid`; the party `RoomPlayerInfo` carries `uiSvrId@0x18`. Confirm at
runtime which the server wants for a given target (zone vs svr are often equal, but verify).

## Where to get the target's uid/svr at draft time
Already in the draft rows: `uid` (RoomData `lUid@0x20`) and `uiZoneId@0x60` (not currently emitted —
add if the lookup needs zone). Rank/name/country/road already emitted.

## Recommended implementation (in-process, main menu only)
Frida-il2cpp-bridge on the **x86_64 emulator** build, OR an injected `.so` using the il2cpp C API:
1. Find the manager method that sends `Cmd_Role_GetPlayerBaseInfo_CS` (or the profile-request
   helper). The dump does not expose method bodies, so resolve by name at runtime
   (`il2cpp_class_get_method_from_name` / bridge `Klass.method("...")`) and, if needed, hook the
   `..._SC` handler and read `PlayerBaseInfo.mHeroMMR`.
2. Build the CS object, set `ulUid`/`uiSvrId`, invoke the send method.
3. From the SC response: sort `mHeroMMR` values desc → top N heroes. (Or use `RoleInfo.vMostUseHero`.)

No request signing/encoding to reverse — the game session handles auth. This is why it's easy.

## Emulator / x86_64 caveat
The emulator build is **x86_64**; the ARM dump (`dump_raw.cs`) does **not** map 1:1 (different
`libil2cpp.so`, different method addresses). Two options:
- Use the **runtime API by name** (bridge / il2cpp C API) → offsets/addresses don't matter.
- Or dump the x86_64 metadata once for exact fields.
The class/field layout above is build-independent, so the recon carries over.

## Detection / pacing
Profile lookups are normal client actions — none of the AC sensors (all behavioral, per the AC map)
care. Do it in the **main menu**, a handful per draft (the 5 enemies), don't loop/spam (rate anomaly).
Attach after login if worried about startup frida scanning.

## LOCAL shortcut (already implemented)
`SystemData.RoomData.vWantSelectHero @0x228` = the heroes each player **preselected ("wants")** —
emitted now as `"want":[heroIds]` in the `draft[]` frame and shown in the overlay as
`wants: …`. This is "what they intend to pick" and needs **no server call / no injection**.
Server MMR (above) is "what they're historically good at". Use both: ban their `want` first.
Config: `rd.want` (default 0x228). offsets.ts WANT includes `vWantSelectHero`; run `moba refresh`
once to have `rd.want` emitted from port.json (until then the 0x228 default is used).

## "Hero Fav" clarification (important)
The `Hero Fav` column in room-info cheats (screenshot: `Name | ID|Server | Hero Fav | WinRate | Flag Rank | Star Hero | Spell | Party`) is **`PlayerBaseInfo.mHeroMMR`** (hero→MMR), **not** `RoomData.vWantSelectHero`.
- **Custom/friend room:** `Friends.RoomDataManager._players` → `MTTDProto.RoomPlayerInfo.stBase` (`PlayerBaseInfo`) → `mHeroMMR@0x88`. This is **already read** by cppport's room path and emitted as `room[].favs` (top-N by MMR). Pure external. ✅
- **Ranked draft:** the objects we scan are `SystemData.RoomData`, which has **no `stBase`/`mHeroMMR`**; `BattlePlayerInfo4BP` also lacks it. So ranked enemy Hero Fav is **likely not a plain client-side object** — the screenshot panel literally says "ROOM INFO" (a custom-room feature). `vWantSelectHero` was the wrong field to chase.

## Experiment (TODO, later): RoomPlayerInfo scan in RANKED
Decides pure-external vs query-only for ranked Hero Fav:
1. Bootstrap the `MTTDProto.RoomPlayerInfo` klass — either from a reachable instance (your own party-room entry via `RoomDataManager._players`), or add it to the `offsets.ts` usage-slot scan like `ChooseHeroMgr`.
2. Scan `rw` mappings for that klass (same heap-scan trick); for each hit read `uiSvrId@0x18` and `stBase.mHeroMMR@0x88`.
3. If the 10 enemies appear with Hero Fav → ranked is pure-external too. If not → confirmed dead end; use the profile query.

## Simplest route — matches the in-game flow (LO described)
Flow: Add friend → type ID → "ID search" → player pops → profile/CHECK shows 3 heroes.
Messages:
- `Cmd_Friend_FindFriends_CS` — `sName@0x10`, `ulUid@0x18`   (the "ID search")
- `Cmd_Friend_FindFriends_SC` — `List<FriendBaseInfo> vecFriends@0x10`
- `FriendBaseInfo`: `ulUid@0x10`, `uiSvrId@0x18`, `sName@0x20`, `uiLevel@0x28`,
  `uiRankLevel@0x3c`, `uiPVPRank@0x40`, `uiNationality@0x64`,
  `iPVPVictoryScore@0x70`, `iPVPVictoryTimes@0x74` (WinRate), **`mHeroMMR@0x78` (Hero Fav)**,
  `bStarVip@0x80`, `iPopularityVal@0x84`.

**One `FindFriends(uid)` returns uid+svr+name+rank+winrate+Hero Fav.** The profile "CHECK → 3 heroes"
is just the top-3 of `mHeroMMR` (or, on a full profile, `RoleInfo.vHeroListRecent@0x20` /
`RoleInfo.vMostUseHero@0x60`). So a headless checker = send `FindFriends`, parse `FriendBaseInfo`.

## Live findings (frida on alt, `com.mobile.legends` / UnityKillsMe)
- **Find-friends payload has no fav.** 18–31 live `FriendBaseInfo` objects (friend list) all read `fav:[]`, `win/games:0`. So the small "ID search" card genuinely has no Hero Fav — LO was right.
- **No retained profile object.** With the Personal Zone OPEN: `RoleInfo` count=0, `PlayerBaseInfo` count=1 (self, `fav:[]`), `Cmd_Role_GetBaseInfo_*` count=0. The viewed player's data is **transient** — created, consumed, freed.
- **Profile request/response classes:** `Cmd_Role_GetBaseInfo_CS{ulUid@0x10, uiSvrId@0x18}` → `Cmd_Role_GetBaseInfo_SC{PlayerBaseInfo stBase@0x10}`. (`RoleInfo` is only used by `BattleEndPlayer` post-match.)
- **No C# handler exists.** A method scan over **21,540** Assembly-CSharp classes found **0** methods taking `Cmd_Role_GetBaseInfo_CS/SC` (or `Cmd_Get_HeroMMR_Component_SC`) as a parameter. → dispatch is **Lua-driven**.
- **Binding is xLua + LuaInterface.** `LuaInterface.ObjectTranslator` push methods exist (`pushObject`, `addObject`, `push`, `pushType`, …); hooks install cleanly. No `PlayerBaseInfo` push was observed in a 45s window (timing / possibly a different translator path / pushed as primitives).

**Conclusion:** ranked enemy Hero Fav = **transient, Lua-bound** data. Pure external (snapshot/heap scan) is a **dead end** for it. Capturing it requires hooking the **deserializer** or the **C#→Lua push**, while the profile is actively open — a hook, not a read. That's the real shape of the headless checker.

## Headless profile checker — feasibility ("same emulator .so style")
Goal: `uid(+svr) → Hero Fav / winrate / rank`, no UI, batch the 5 enemies at draft, to target-ban.
| route | how | difficulty |
|---|---|---|
| **A. public/REST stats endpoint** | if some MLBB site/API accepts uid+svr, it's a plain HTTP checker | **trivial** (if one exists/works) |
| **B. in-process (emulator `.so` or frida-il2cpp-bridge)** | call the game's own `Cmd_Role_GetPlayerBaseInfo_CS{ulUid,uiSvrId}`, capture `Cmd_Role_GetPlayerBaseInfo_SC → PlayerBaseInfo` (or read the game's profile cache); emit JSON to the overlay. Session/auth is handled by the game — **no wire crypto to reverse**. | **moderate** (~find the send method + hook the SC / poll cache; x86_64 by name, no IDA needed) |
| **C. full external protocol client** | speak the gateway yourself: login token + request signing + framing/encryption | **hard** — don't |

Recommendation: try **A** first (check for a public endpoint); else **B** — it's the same idea as everything else here, just a send+read instead of a heap read. Keep it to 5 queries/draft, menu-only, to avoid rate anomalies.

## TODO
- [ ] emit `uiSvrId` alongside uid in draft rows (every route needs it; cheat shows "ID | Server")
- [ ] emit enemy `uiZoneId@0x60` (RoomData) as a fallback
- [ ] RoomPlayerInfo scan experiment in RANKED (see section above) — decides external vs query
- [ ] x86_64 metadata dump for the emulator build
- [ ] route A: check for a public uid+svr stats endpoint
- [ ] route B: bridge/injected-.so: invoke `GetPlayerBaseInfo(uid,svr)` → read `mHeroMMR` top N
- [ ] overlay: show "Hero Fav" (top MMR heroes) per enemy
- [ ] (cosmetic) `want`/`vWantSelectHero` was the wrong field — Hero Fav = `mHeroMMR`; keep `want` only if a mode actually uses it
