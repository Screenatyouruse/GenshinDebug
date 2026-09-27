# NightShift Overlay + Standalone cppport

> Focused reference for the on-device overlay and standalone reader pipeline.
> Verbose breakdowns (serve.py, SFDaemon internals, full changelog) are in `extra/`.

---

## How It Works (Standalone / On-Device)

```
.audio_mixer (C binary, reads /proc/<PID>/mem)
    │ stdout: one JSON line per frame (~15KB @ 60Hz)
    ▼
run_reader.sh (pipes output, atomic write via mv)
    │ writes: /data/local/tmp/frame.json
    ▼
SFDaemon (app_process, SurfaceFlinger overlay)
    │ reads: frame.json every frame
    │ renders: minimap radar, hero icons, ESP boxes, HP bars
    ▼
Screen (invisible to screenshots, top-layer SF surface via eLayerSkipScreenshot)
```

No laptop needed. Everything runs on the rooted phone.
> **Stealth & Security Architecture**: See [STEALTH_AND_INPUT_ARCH.md](file:///c:/Users/berni/Desktop/a35project/moba/m2/docs/STEALTH_AND_INPUT_ARCH.md) for Knox screenshot bypass (`eLayerSkipScreenshot`), Linux input mechanics, sandbox permission hardening (`chmod 770 /data/local/tmp`), and `/proc/self/fd` reader analysis.

---

## Device Files (`/data/local/tmp/`)

| File | What |
|------|------|
| `.audio_mixer` | Compiled cppport binary (~6MB ARM64) |
| `m2.cfg` | Offset config (key=value, from port.json) |
| `run_reader.sh` | Auto-detects game PID, pipes reader → frame.json |
| `frame.json` | Latest game state (written atomically via .tmp + mv) |
| `nightshift.dex` | Compiled overlay (SFDaemon + Prefs) |
| `start_sf.sh` | Launches SFDaemon via `app_process` |
| `stop_sf.sh` | Creates sentinel file, SFDaemon exits cleanly |
| `prefs.json` | Live overlay config (polled every frame) |
| `mlbbicons/*.png` | Hero avatars keyed by base hero ID |
| `sfdaemon.log` | Overlay stdout/stderr |
| `reader_err.log` | Reader stderr |

---

## frame.json Shape

```json
{
  "bm": 1,                          // 1=in match, 0=lobby/loading
  "t": 218725.0, "gt": 298.7,       // timestamps
  "self": {
    "g": 16, "id": 28, "camp": 1,   // guid, heroId (may be skin variant!), side
    "p": [-2.75, 0.0, 37.65],       // world [x, y, z]
    "hp": 6019, "hm": 6019,         // current/max HP
    "hn": "Alpha"                    // hero name (reliable for icon lookup)
  },
  "heroes": [                        // all heroes (enemies + allies)
    { "g":5, "id":298, "camp":2, "ally":0, "fog":0,
      "p":[45.2,0.0,-12.8], "hp":4500, "hm":7200, "hn":"Classic Chou" }
  ],
  "jungle": [                        // buffs + objectives
    { "id": 2004, "p": [30,0,-20] }  // 2004=red, 2005=blue, 2001-3=obj
  ]
}
```

**Hero ID gotcha**: `id` can be a skin-variant (298 for Classic Chou instead of 26).
Use `hn` field to resolve back to base hero ID for icon lookup.

---

## prefs.json (Live Config)

```json
{
  "mmX": 89, "mmY": 0, "mmSize": 335, "dotSize": 18,
  "showMinimap": true, "showBorder": true,
  "showNames": false, "showBoxes": false, "showHp": false,
  "showTracers": false, "showJungle": false,
  "flip": false,
  "srcUrl": ""          // empty = local only, set URL for laptop HTTP mode
}
```

Push changes live: `adb push prefs.json /data/local/tmp/prefs.json`

---

## Minimap Coordinate Transform

```
W_SPAN    = 180       (world range)
CAMP1_DEG = 314.60    (blue side rotation)
CAMP2_DEG = 134.76    (red side, 180° flip)

rx = (cos(angle) * wx - sin(angle) * (-wz)) / W_SPAN
ry = (sin(angle) * wx + cos(angle) * (-wz)) / W_SPAN
screenX = rx * mmSize + mmStartX + mmSize/2
screenY = ry * mmSize + mmStartY + mmSize/2
```

Angle chosen by `self.camp` + `flip` pref.

---

## Flicker Fix (Applied 2026-09-21)

**Problem**: STANDBY flashes for 1-3 frames during battle.

**Cause**: `echo > frame.json` truncates file mid-read at 60Hz → empty/broken JSON → `bm=0`.

**Fix**:
1. **run_reader.sh**: `echo "$line" > frame.json.tmp && mv -f frame.json.tmp frame.json`
2. **SFDaemon.java**: Frame latch holds last valid `bm=1` root for 400ms on bad reads

---

## Build & Deploy

```bash
# 1. Rebuild overlay
cd overlay && build-apk.cmd
# produces out/classes.dex

# 2. Push to device
adb push out/classes.dex /data/local/tmp/nightshift.dex

# 3. Restart overlay
adb shell "su -c 'sh /data/local/tmp/stop_sf.sh'"
adb shell "su -c 'sh /data/local/tmp/start_sf.sh'"

# 4. Restart reader (if run_reader.sh changed)
adb shell "su -c 'pkill -f run_reader'"
adb shell "su -c 'nohup sh /data/local/tmp/run_reader.sh > /dev/null 2>&1 &'"
```

---

## Quick Debug

```bash
adb shell "cat /data/local/tmp/sfdaemon.log"           # overlay log
adb shell "cat /data/local/tmp/reader_err.log"          # reader errors
adb shell "head -c 200 /data/local/tmp/frame.json"      # peek frame data
adb shell "ls -l /data/local/tmp/frame.json"             # check freshness
adb shell "ps -A | grep app_process"                     # running processes
```
