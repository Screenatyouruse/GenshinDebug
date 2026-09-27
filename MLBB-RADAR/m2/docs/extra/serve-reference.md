# serve.py — Laptop Mode Reference

> How the laptop orchestrator works, for when you need to modify or debug it.

---

## What serve.py Does

1. **Deploys** `.audio_mixer` binary to device via `adb push`
2. **Detects** MLBB process (`com.mobile.legends:UnityKillsMe`)
3. **Generates** offset config (`m2.cfg`) from `port.json` in memory
4. **Streams** game data via `adb shell su -c ".audio_mixer <PID> 16"` piped through stdin
5. **Serves** HTTP on `0.0.0.0:8080`:
   - `GET /map.json` → latest frame JSON (the `LATEST` global)
   - Everything else → static files from `www/`

---

## Key Functions

### `build_cfg_payload()` (lines 71-175)

Reads `port.json` → generates `m2.cfg` format as bytes. This is the heart of the
offset system. It reads from three candidate paths:

```python
candidates = [
    os.path.join(os.path.dirname(ROOT), "port.json"),   # parent dir
    os.path.join(ROOT, "meta", "port.json"),             # meta/ subdir
    os.path.join(ROOT, "port.json")                      # same dir
]
```

Takes the **freshest** by mtime (because `refresh-offsets.cmd` writes to `meta/port.json`
and the parent copy may be stale since runtime static addresses are per-session).

### Config Lines Generated

```python
# Static field addresses (resolved at runtime)
st("BattleData", "m_BattleBridge")       # → static.BattleData.m_BattleBridge=0x...
st("BattleManager", "Instance")          # → static.BattleManager.Instance=0x...

# Instance field offsets
ins("BattleManager", "m_LocalPlayerShow")  # → inst.BattleManager.m_LocalPlayerShow=120
ins("BattleManager", "m_ShowPlayers")
ins("BattleManager", "m_ShowMonsters")
ins("BattleManager", "m_dicMonsterShow")
ins("BattleManager", "m_dicPlayerShow")

# Entity fields (ShowEntity class)
for f in ["m_uGuid", "m_ID", "m_EntityCampType", "m_bDeath", "m_bSameCampType",
          "canSight", "m_vCachePosition", "m_Hp", "m_HpMax", "m_RoleName", "m_OwnSkillComp"]:
    → ent.{f}={offset}

# ShowPlayer-specific
→ ent.m_iSummonSkillId={offset}
→ sp.m_HeroName={offset}

# Skill system
→ own.m_SkillList={offset}
→ sd.m_TranID={offset}
→ lf.m_SkillComp={offset}
→ lsc.m_CoolDownComp={offset}
→ cdc.m_DicCoolInfo={offset}

# Class/slot addresses
→ klass.LogicBattleManager=0x...
→ slot.BattleManager=0x7646060       (default RVA)
→ slot.LogicBattleManager=0x7684B38  (default RVA)
→ slot.ChooseHeroMgr=0x...           (if available)

# Timer/cooldown config
→ timer.klassSlot={value}
→ timer.nowOff={value}
→ timer.cdA={value}
→ timer.cdB={value}
→ ent.fighterCache=968

# Draft/Room data (for lobby ESP)
→ static.RoomDataManager._instance=0x...
→ rpi.uid={offset}     (RoomPlayerInfo fields)
→ rpi.svr, rpi.name, rpi.nation, rpi.rank, rpi.rankBig, rpi.base,
  rpi.country, rpi.online, rpi.ready, rpi.camp, rpi.road, rpi.want
→ pbi.heroMMR, pbi.vTimes, pbi.vScore
→ rd.players={offset}

# Draft roster (ChooseHeroMgr)
→ static.ChooseHeroMgr.Instance=0x...
→ ch.selfList={offset}
→ rd.uid, rd.camp, rd.pos, rd.name, rd.robot, rd.heroid,
  rd.skin, rd.country, rd.rank, rd.road, rd.ban, rd.choose
```

### `untag(handle)` (line 64)

Strips ARM MTE/PAC tagged pointers:
```python
def untag(handle):
    v = int(handle, 16) if isinstance(handle, str) else int(handle)
    return v & 0x00FFFFFFFFFFFFFF
```

### `stream_session(pid, interval_ms, cfg_payload)` (line 207)

```python
proc = subprocess.Popen(
    ADB + ["shell", "su", "-c", f"exec {BIN_DEVICE} {pid} {interval_ms}"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
proc.stdin.write(cfg_payload)  # send config
proc.stdin.flush()
proc.stdin.close()

for raw in iter(proc.stdout.readline, b""):
    line = raw.decode(errors="replace").strip()
    if line.startswith("{"):
        LATEST = line  # global, served via /map.json
    elif line:
        print("[reader]", line)  # debug output from binary
```

### `serve(www, port=8080)` (line 200)

```python
handler = functools.partial(MapHandler, directory=www)
httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
```

`MapHandler` overrides `do_GET`:
- `/map.json` → returns `LATEST` with no-cache headers
- Everything else → serves from `www/` directory

### `main()` (line 238)

```python
deploy_bin()           # adb push .audio_mixer
serve(www)             # start HTTP server

while True:
    pid = newest_pid()  # find game process
    if not pid:
        print("[*] waiting for game engine child...")
        time.sleep(3)
        continue
    
    cfg_payload = build_cfg_payload()   # generate config from port.json
    stream_session(pid, interval, cfg_payload)  # blocks until game closes
    time.sleep(2)  # wait before reconnecting
```

---

## Running

```bash
cd moba
python serve.py                    # default 16ms interval (~60Hz)
python serve.py --hz 30            # 30Hz (33ms interval)
python serve.py --interval 50      # explicit 50ms interval
```

Then set `srcUrl` in prefs.json on device:
```json
{ "srcUrl": "http://<laptop-ip>:8080/map.json" }
```

---

## Draft/Lobby ESP Keys

serve.py also generates config for pre-match lobby data:

| Config Key | Source Class | Field | Purpose |
|-----------|-------------|-------|---------|
| `rpi.uid` | MTTDProto.RoomPlayerInfo | ulUid | Player UID |
| `rpi.rank` | MTTDProto.RoomPlayerInfo | uiRankLevel | Rank |
| `rpi.name` | MTTDProto.RoomPlayerInfo | strName | Player name |
| `rpi.camp` | MTTDProto.RoomPlayerInfo | iActCamp | Team assignment |
| `rpi.road` | MTTDProto.RoomPlayerInfo | iRoad | Lane assignment |
| `rpi.want` | MTTDProto.RoomPlayerInfo | vWantSelectHero | Wanted hero |
| `pbi.heroMMR` | MTTDProto.PlayerBaseInfo | mHeroMMR | Hero MMR |
| `rd.uid` | SystemData.RoomData | lUid | Room player UID |
| `rd.heroid` | SystemData.RoomData | heroid | Selected hero |
| `rd.rank` | SystemData.RoomData | uiRankLevel | Player rank |

These are used by the C binary for draft-phase ESP (seeing enemy picks, ranks, etc.
before the match starts).
