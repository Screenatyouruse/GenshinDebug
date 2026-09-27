# NightShift — Changelog & Fix Log

> All bugs found, diagnosed, and fixed during this session.
> Date: 2026-09-21

---

## Fix #1: Minimap 180° Rotation (Self Dot on Wrong Side)

**Bug**: When playing on Lord side (camp 2), the self dot appeared on the Turtle side
of the minimap — exactly 180° off.

**Root Cause**: Only one rotation angle (`W_ANGLE_CAMP1 = 314.60f`) was used regardless
of which camp/side the player was on.

**Fix**: Added second constant `W_ANGLE_CAMP2 = 134.76f` (180° offset from camp1).
Dynamic selection based on `self.camp`:

```java
boolean isCamp2 = (selfCamp == 2);
boolean inverted = isCamp2 ? !flipMinimap : flipMinimap;
float angleDeg = inverted ? W_ANGLE_CAMP2 : W_ANGLE_CAMP1;
```

**Status**: ✅ Fixed and deployed

---

## Fix #2: Refresh Rate Synchronization

**Bug**: Entity positions on the overlay lagged behind the actual game, causing
a visible "drift" effect when moving.

**Root Cause**: SFDaemon used a hardcoded `Thread.sleep()` interval that didn't
match the device's actual refresh rate.

**Fix**: Query `DisplayInfo.refreshRate` via reflection at startup:

```java
float hz = ...; // from getActiveDisplayMode reflection
long frameSleepMs = (long)(1000f / hz); // 17ms for 60Hz
System.out.println("[*] Display: " + bufW + "x" + bufH + " @ " + hz + "Hz (delay=" + frameSleepMs + "ms)");
```

**Status**: ✅ Fixed and deployed

---

## Fix #3: Standby Flicker (1-3 Frame Drops to STANDBY)

**Bug**: During active matches, the overlay would flash "NightShift [STANDBY]" with
cyan border for 1-5 frames every 1-2 seconds. Enemy icons would disappear during
these flicker frames.

**Root Cause**: Two-part race condition:

1. **Writer side** (`run_reader.sh`): `echo "$line" > frame.json` uses `O_TRUNC|O_WRONLY`,
   meaning every write first truncates the file to 0 bytes, then writes ~15KB of JSON.
   At 60Hz, this creates a window where `frame.json` is 0 bytes or partially written.

2. **Reader side** (`SFDaemon.java`): `readString()` opens the file during the truncation
   window, reads 0 bytes or partial JSON, `new JSONObject()` throws an exception caught
   by `catch (Throwable ignored)`, leaving `root=null` and `bm=0` → renders STANDBY.

**Occurrence rate**: ~2-5% of reads (about 1-3 times per second at 60Hz).

**Fix (two-part)**:

### Part A: Atomic Write in run_reader.sh

```diff
- [ -n "$line" ] && echo "$line" > "$OUT"
+ [ -n "$line" ] && echo "$line" > "${OUT}.tmp" && mv -f "${OUT}.tmp" "$OUT"
```

`mv` (rename) is atomic on Linux — readers never see a 0-byte or half-written file.

### Part B: Frame Latch in SFDaemon.java

```java
// Declared before main loop
JSONObject lastValidRoot = null;
long lastValidBmTime = 0;

// Inside render, after JSON parse attempt:
if (root != null && root.optInt("bm", 0) == 1) {
    lastValidRoot = root;
    lastValidBmTime = now;
    bm = 1;
} else if (now - lastValidBmTime < 400 && lastValidRoot != null) {
    root = lastValidRoot;  // hold last good frame for up to 400ms
    bm = 1;
}
```

If a frame parse fails, the previous valid frame is reused for up to 400ms. This is
a safety net even with atomic writes — covers edge cases like filesystem delays.

**Status**: ✅ run_reader.sh pushed to device. SFDaemon.java latch added by user manually.
Needs rebuild + deploy to verify.

---

## Fix #4: Hero Avatar PNGs Not Rendering

**Bug**: Minimap shows plain colored dots instead of hero avatar images, even though
133 PNG icons were pushed to `/data/local/tmp/mlbbicons/`.

**Root Cause**: MLBB memory reports skin-variant IDs instead of base hero IDs for
certain heroes. Example: Chou with Classic skin reports `id: 298` but the icon file
is `26.png`. The icon lookup searches for `298.png` which doesn't exist, falls back
to a plain dot, and caches `null` forever for that ID.

**Heroes affected**: Any hero using a non-default skin, plus all bot heroes.

| Hero | Expected ID | Actual ID in Memory | `hn` field |
|------|------------|--------------------:|------------|
| Chou (Classic) | 26 | 298 | "Classic Chou" |
| Zilong (Bot) | 16 | 9996 | "Bot Zilong" |

**Planned Fix**: `resolveHeroId(int rawId, String heroName)` function that:
1. Checks if `rawId.png` exists in mlbbicons/
2. If not, strips prefixes ("Classic ", "Bot ", "Epic ") from `heroName`
3. Looks up base hero ID from a name→ID map
4. Falls back to rawId if nothing matches

**Status**: 🔧 Designed but not yet wired into the live SFDaemon.java render loops.
The scratch_diff version may have it partially implemented. Needs:
- Wire `resolveHeroId()` calls in the enemy hero loop and self dot rendering
- Build a comprehensive name→ID map (or scan mlbbicons/ filenames)

---

## Fix #5: Local cppport / On-Device Reader

**Context**: Originally the reader only ran via laptop (`serve.py` → adb shell piping).
User wanted fully standalone on-device operation.

**Implementation**: `run_reader.sh` was created to:
1. Auto-detect MLBB PID via `ps -ef | grep com.mobile.legends`
2. Launch `.audio_mixer <PID> 16` with config from `m2.cfg` via stdin redirect
3. Pipe stdout JSON lines to `frame.json` (now with atomic write)
4. Auto-restart on game close/restart

**Config generation**: For on-device mode, `m2.cfg` needs to be pre-generated from
`port.json` and pushed to the device. The laptop `serve.py` generates this in memory
via `build_cfg_payload()`, but for standalone mode it needs to be a static file.

**Status**: ✅ Working

---

## Fix #6: Parallel HTTP + Local Support

**Context**: User wanted both laptop web map AND phone overlay to work simultaneously
from the same data source.

**Implementation**: SFDaemon's data source selection picks the freshest source:
- HTTP worker thread polls `srcUrl` from prefs.json every 40ms
- Main loop compares `httpAge` vs `fileAge` (both must be < 3.5s to be valid)
- Freshest wins; ties go to HTTP

**Status**: ✅ Working

---

## Pending / TODO

1. **resolveHeroId()** — Wire into SFDaemon render loops for proper icon display
2. **Verify flicker fix** — Rebuild DEX with latch, deploy, test in match
3. **setSecure bypass** — User mentioned wanting to disable it for scrcpy visibility
   during testing (currently overlay is invisible to screen capture)
4. **Git cleanup** — moba/ folder had tracking issues due to large binary files
