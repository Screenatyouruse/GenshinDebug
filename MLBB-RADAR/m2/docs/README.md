# m2 docs — read in this order

All project notes consolidated here. The toolchain itself is one level up (`moba/m2/`).

| # | file | what it is |
|---|---|---|
| 0 | **AGENT_GUIDE_AND_WORKFLOWS.md** | **WHAT IS IT & WHAT TO DO WITH IT.** The essential onboarding guide and operational runbook for any agent working on m2. Directory map, end-to-end data flow, file inventory, step-by-step developer recipes, and common trap warnings. |
| 1 | **HANDOFF.md** | **CURRENT state.** Run flow, layout, draft enemy pipeline (camp fix), perf work, JSON fix, `moba debug`, known quirks, pending items, golden rules. Read this first. |
| 1b | **MATCH_LIFECYCLE_AND_GAME_OVER.md** | **Game Over & bm:1 Fix.** Reverse engineering findings on `BattleManager.m_MainTowerDead` (+128), memory lifecycles, and synchronization with auto-recording and UI. |
| 1c | **REPLAY_AND_DRAFT_SYSTEM.md** | **Minimap Replay Studio & Draft System.** Architecture for persistent `/draft.json`, `.mreplay` match file format, and `replay.html` scrubber controls. |
| 2 | **BATTLEFIELD_FETCH.md** | **WORKING:** other players' winrate + most-used heroes via `il2cpp_runtime_invoke(FriendManagerController.RequestBattleData)`. IDA addresses, message field maps, scripts, open questions. Read for the pro/hide-history work. |
| 2b | **PROFILE_LOOKUP.md** | earlier recon for the same hunt (message shapes, transient/Lua-bound findings, routes). Partly superseded by BATTLEFIELD_FETCH.md. |
| 3 | **HEADER_FORMAT.md** | Moonton v1024 il2cpp metadata format decode + research notes. |
| 4 | **LUA_FINDINGS.md** | Notes from the leaked Lua scripts. |
| 5 | **TIME_SINKS.md** | Lessons/things that wasted time — read before re-deriving. |
| 5b | **PATCH_DAY_LESSONS.md** | **Read before any post-update debug.** What a patch breaks (struct/static offsets), the skill/CD chain, the practice-vs-real gotcha, refresh-pipeline traps, and the don't-repeat checklist. |
| 6 | **AGENT_HANDOFF_legacy.md** | **LEGACY — partly superseded and partly WRONG.** Its "room hack = draft intel" premise was disproven; the real path is in HANDOFF.md. Keep for historical offsets/anti-cheat map. |
| 7 | **ENI_CONTRIBUTION.md** | **Full Macro Intelligence & System Architecture.** Author: ENI. External memory telemetry, creep combat anchors, battle spell decoding, dual-clock engine, threat HSM, and performance clamps. |
| 7b | **MACRO_INTEL_AND_CLOCKS.md** | Operational guide: creep animation/HP signals, battle spell mapping (`0x964`), and clock normalization. |
| 8 | **OVERLAY_MINIMAP_AND_W2S.md** | **In-game overlay dev doc.** WebView corner-minimap architecture, `frame.json` transport, proven minimap transform, and the definitive W2S route (call Unity `Camera.WorldToScreenPoint`; do NOT hand-roll). Read before touching `overlay/` or `web.html`. |
| 9 | **UI_HOOKS_AND_PIP.md** | **UI Text Hooks, Stalker Modernization, & Native Canvas PiP.** Author: ENI. NGUI `UILabel` hooking, Il2Cpp string GC traps, post-patch `stalk.js` reflection architecture, and browser PiP radar implementation. |
| 10 | **STEALTH_AND_INPUT_ARCH.md** | **Stealth Rendering, Input Mechanics, & Sandbox Security.** Author: ENI & LO. Samsung Knox screenshot bypass (`eLayerSkipScreenshot` vs `FLAG_SECURE`), Linux touch input kinematics (`/dev/input/eventX` vs `uinput`), `/proc/self/fd/` myth debunked, and `/data/local/tmp` UID 10412 lockdown. |

## 10-second context
- Canvas is `m2/` (clean toolchain). `moba/` is the older experimental copy.
- Runtime is **fridaless** (`adb` + external reader `/data/local/tmp/.audio_mixer`). Frida only for `moba refresh` (offsets) and probes.
- Draft enemies: `slot.ChooseHeroMgr -> m_SelfCampHeroInfoList` (your 5) → klass from an ally header → scan rw mappings for the other camp (`camp != selfCamp`, not-an-ally-addr).
- **Never** inline `adb shell su -c "complex; chain"` from Windows — push a `.sh` and `su -c "sh …"`.
- Epic Sins of the Ancients (don't repeat): `vWantSelectHero` was the wrong field (it's `mHeroMMR`); `camp` is absolute not us/them; frida CLI dies on piped stdin.
