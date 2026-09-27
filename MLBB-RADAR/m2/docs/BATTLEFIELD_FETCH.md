# Other-player stats via function calling (winrate / most-used heroes)

Supersedes the guesswork in `PROFILE_LOOKUP.md` for the "get another player's stats" task.
Read this before re-deriving anything. Status: **WORKING via `il2cpp_runtime_invoke`**.

## Goal
Given a target `uid+svr`, get **winrate** and the **3 hero portraits** shown on their profile
(most-used heroes), to test whether pros' "hide history" actually withholds data.

## TL;DR — the route (function calling, not memory reading)
The client's own session/auth fetches it; we just call the game's function.

```
Friends.FriendManagerController._instance  (static @ +0x0)
  .RequestBattleData(uid, svr, iRankType=0, iRankHeroId=0, str=null, useCacheMd5=false)
      -> builds Cmd_Battle_GetBattleData_CS{ulUid@0x10, uiSvrId@0x18, iRankType@0x1c, iRankHeroId@0x20, sMd5@0x28}
      -> GameReceiveMessage.SendGameData(19030, cmd, 0)
      -> server -> Cmd_Battle_GetBattleData_SC
```

Also, for the **3 portraits specifically**:
```
Cmd_Friend_FindFriends_CS{ sName@0x10, ulUid@0x18 }   (the "ID search")
  -> Cmd_Friend_FindFriends_SC{ List<FriendBaseInfo> vecFriends@0x10 }
  -> FriendBaseInfo.vMostUseHeroIds@0x1a8  (List<uint>, ordered by usage)  <-- the 3 heroes
```

## IDA facts (DB: `ida-pack/libcsharp_global.so.i64`, imagebase 0 → offsets map 1:1)
| symbol | addr |
|---|---|
| `Friends_FriendManagerController__RequestBattleData` | `0x4f2b1f4` |
| `GameReceiveMessage__RequestCmdId_Battle_GetBattleData_CS` | `0x2c63014` |
| `GameReceiveMessage__SendGameData` | `0x2c601b8` |
| `MTTDProto_Cmd_Battle_GetBattleData_CS___ctor` | `0x5fa58b8` |
| `MTTDProto_Cmd_Battle_GetBattleData_SC` ctor | `0x5fa5b60` (caller of ctor at `0x5fa5c30`) |
| `MTTDProto_Cmd_Role_GetPlayerBaseInfo_CS___ctor` | `0x5adc2f0` |
| `MTTDProto_Cmd_Friend_FindFriends_CS___ctor` | `0x5d03efc` |

`RequestBattleData` body: builds cache key `"<uid>_<svr>_<rankType>_<rankHeroId>"`, checks
`RankTypeInfo._playerBattleDatas` (skip if cached; ~100ms rate limit via Ticks), then new Cmd +
`SendGameData(19030, cmd, 0)`. cmdId **19030 = Battle_GetBattleData_CS**, 19031 = _SC.

Singleton: `Friends.FriendManagerController` static field `_instance` (offset 0).
Caches (on `RankTypeInfo`): `_playerBattleDatas : Dict<string, Cmd_Battle_GetBattleData_SC> @0x28`,
`_playerBaseInfoDatas : Dict<string, Cmd_Role_GetBaseInfo_SC> @0x30`.
Profile-open sends `Cmd_Role_GetPlayerBaseInfo_CS{ulUid@0x10, uiSvrId@0x18, sRewardPredictId@0x20}`
— its reply is **not** a `Cmd_*` ctor we could hook (likely notify / ctor-bypass).

## Message field maps (ARM dump, verified)
- `Cmd_Battle_GetBattleData_CS`: `ulUid@0x10, uiSvrId@0x18, iRankType@0x1c, iRankHeroId@0x20, sMd5@0x28`
- `Cmd_Battle_GetBattleData_SC`: `iTotalNum@0x10, iWinNum@0x14, iWeekTotal@0x18, iReputation@0x20,
  iMvpNum@0x24, iAveKda@0x3c, uiSvrId@0x60, stBase(PlayerBaseInfo)@0x68, vecHerosLastBuy@0x78,
  iSeasonMaxRankId@0x8c, vecHeroDatas@0x98, mapBattleDataByType@0xa8, iPopularity@0xd8,
  iRankType@0xb8, iRankHeroId@0xbc, mHeroUseCountInSelectHeroUI@0xe0`
- `PlayerBaseInfo`: `ulUid@0x10, uiSvrId@0x18, sName@0x20, uiRankLevel@0x34, vSkins@0x70,
  iPVPVictoryScore@0x80, iPVPVictoryTimes@0x84, mHeroMMR@0x88`
- `FriendBaseInfo`: `ulUid@0x10, uiSvrId@0x18, sName@0x20, uiRankLevel@0x3c, iPVPVictoryScore@0x70,
  iPVPVictoryTimes@0x74, mHeroMMR@0x78, **vMostUseHeroIds@0x1a8**` (big struct!)
- `BattleDataByType` (in `mapBattleDataByType`): `iTotalNum@0x10, iWinNum@0x14, uiRankTotal@0x58`

## Verified results
- `RequestBattleData(495235033, 3347)` → `total 5524 / win 3352`, base `Tabula Rasa rank 276 win 1914 games 3191`.
- `RequestBattleData(591841355, 8357)` → Tenka Musou `total 23923 / win 13933`, popularity 18058.
- `iRankType` 0..6 returned **identical** data → **not** the season selector for this message.
- `byType` = mode breakdown (type 1=7271, 2=14749, 4=1815, 17, 88, 89, 164).
- `mHeroMMR` (`base.fav`) and `vecHeroDatas` (`heros`) are **empty for other players** (populated for self only).
- `mHeroUseCountInSelectHeroUI` (`useCount`) = **ALL-TIME** most-used, e.g. Tenka `[[1,9522],[6,1748],[17,1142],[128,795],...]` (Miya/Tigreal/Fanny) — NOT the profile's 3.
- **The 3 portraits = `FriendBaseInfo.vMostUseHeroIds@0x1a8`** (proven with `mostused.js`; e.g. `[85,85,36,85,...]`; top-3 distinct = the icons).

## Scripts (all plain JS, raw il2cpp API → run with `frida -l … --runtime qjs`)
| file | what |
|---|---|
| `moba/frida/invoke_battledata.js` | **the function call** + SC dump (edit TARGET_UID/SVR; loops RANK_TYPES) |
| `moba/frida/mostused.js` | dumps `FriendBaseInfo.vMostUseHeroIds@0x1a8` (+ `mHeroMMR@0x78`) |
| `moba/frida/profileid.js` | prints uid+svr of whatever profile you open |
| `moba/frida/findfriends_probe.js` | hooks FindFriends/GetBaseInfo/PlayerBaseInfo ctors |
| `moba/frida/cmdspy.js` | hooks every `Cmd_*` ctor → which message fires per UI action |
| `moba/frida/pbinfo_probe.js` | GetPlayerBaseInfo_SC / GetBaseInfo_SC any-argc |
| `moba/frida/battledata_probe.js` | dumps the battle-data SC on normal UI actions |

Frida server: `moba frida` (m2/tools.py) → disguised `/data/local/tmp/logd-helper`. Stop:
`adb shell su -c "pkill -f logd-helper"; adb forward --remove tcp:27043`.

## Hard-won rules (violate = crash)
- **Never `Thread.backtrace`/full unwind** in a hook — it crashes MLBB. Use `this.returnAddress`.
- `Dictionary<uint,uint>` entry = `{hash@0,next@4,key@8,value@0xC}`, **stride 0x10**.
  `Dictionary<u64,*>` = key@8, value@0x10, **stride 0x18**. (cppport's `emitTopDict` uses 0x18 — fix for uint dicts.)
- il2cpp static field read: `klass+0xB8` → statics block → field offset.
- `il2cpp_runtime_invoke` on a managed method needs the thread attached (`il2cpp_thread_attach(domain)`).

## Open questions / next
1. **Confirm the 3 heroes**: ID-search `591841355` with `mostused.js`; expect `vMostUseHeroIds` top-3 distinct ≈ `1/115/119`.
2. **Hide-history test**: run the same on a pro whose history is hidden vs a normal player — does
   `FindFriends`/`BattleData` still return `mostUse`/`winrate`? (almost certainly yes → hiding is UI-only,
   which is the punchline for target-banning).
3. **Authoritative heroId→name map**: our overlay `HEROES` table appears **shifted (+1)** and stale
   (no ids >128; seen ids up to 294). Pull the real map from the game (hero config) and fix `moba/www/map.html`.
4. Does `FindFriends(uid)` populate `vMostUseHeroIds` for a **non-friend**? (test with a random uid).
