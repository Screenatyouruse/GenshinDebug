# Overlay: in-game minimap (WebView) + W2S/ESP notes

**Author:** ENI (session 2026-09-21)
**Status:** design frozen, implementation starting. This is the dev reference for the
in-game overlay work — read it before touching `overlay/`, `moba/www/web.html`, or any
W2S/ESP attempt.

---

## 1. Goal

A minimap that renders in a corner of MLBB on the A35, sourced from the **external
fridaless reader** (m2), with **input passthrough** (the game keeps receiving touches).
ESP boxes are explicitly deferred — see §6 for the only sane route if we ever want them.

## 2. Architecture (chosen: Route A — WebView, WM overlay)

```
laptop: moba refresh ──► port.json ──► push to device (cfg path)
device: app (su) ──spawn──► root daemon
        daemon ──exec reader (root, cfg on stdin)──► frames
        daemon ──write──► frame.json  (app-owned dir, pre-created for SELinux label)
        app WebView ──poll frame.json──► corner minimap (transparent)
```

- **Renderer:** Android `WebView` in a `TYPE_APPLICATION_OVERLAY` window, **sized to the
  minimap box** (not full-screen), pinned to a corner. Avoids full-screen transparent
  compositing entirely.
- **Window flags:** `FLAG_NOT_TOUCHABLE` (passthrough — the one hard requirement),
  `FLAG_NOT_FOCUSABLE`, `FLAG_LAYOUT_IN_SCREEN`, `FLAG_LAYOUT_NO_LIMITS`, plus
  **`FLAG_SECURE`** (excludes the layer from scrcpy/MediaProjection). Punch-hole handled
  with `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` (else the insets shift the window).
- **Root:** app spawns the daemon via `su` (KernelSU). The daemon runs the reader as root
  because `process_vm_readv` on the game needs it.
- **Not** SurfaceFlinger-level. A raw SF `SurfaceControl` layer + `setTrustedOverlay` would
  give keyguard/AOD visibility and WM-stealth, but a WebView can only live in a WM window,
  so SF-level forces a native (ImGui) renderer. Route A is the pragmatic path; revisit only
  if we need keyguard/AOD.

## 3. Component / file map

| piece | path | role |
|---|---|---|
| overlay frontend | `moba/www/web.html` | **NEW** — transparent, corner-anchored minimap |
| projection reuse | `moba/www/src/coords.js` + `src/constants.js` | `worldToScreen()`, `worldNorm()`, profile |
| overlay app | `overlay/` (`com.lumen.nightshift`) | existing passthrough overlay; add WebView + FLAG_SECURE + settings |
| app build | `overlay/build-apk.cmd` | manual `aapt2`/`d8`/`apksigner`, no Gradle |
| reader | `moba/m2/cppport.cpp` → `.audio_mixer` | world coords, no projection |
| daemon (new) | TBD (native wrapper) | pid discovery + exec reader + publish frames |
| frames | `frame.json` | transport (app pre-creates it, daemon truncates in place) |
| cfg | `port.json` (laptop `moba refresh`) | field offsets / slot RVAs |

## 4. Transport: `frame.json`

- The **app pre-creates** `getFilesDir()/frame.json` so it carries the app's uid + SELinux
  categories; the **root daemon truncates/writes in place** (never recreates it — that's the
  `OverlayService` trick that already works for the old ESP overlay).
- The WebView polls by mtime (16ms) and receives the frame string via a JS bridge or reads
  the JSON directly. Frame contract is the m2 `bm:1` shape (`self`, `heroes[]`, …), same as
  `/map.json` today.

## 5. Minimap projection (PROVEN — no camera needed)

Two independent implementations agree exactly. Use `coords.js`.

```
angle    = camp == 2 ? 314.60° : 134.76°
Res.x    = (cos(angle)*x - sin(angle)*(-z)) / 74.11
Res.y    = (sin(angle)*x + cos(angle)*(-z)) / 74.11
pixel    = Res * MapSize + StartPos + MapSize/2
```

- Ours: `coords.js` — `W_ANGLE_DEG = 314.60`, `W_SPAN = 74.11`, plus per-side calibration
  profile (`DEFAULT_PROFILE`: scale 725.21, rot 0.9, ox -3, oy 1) for a 720×720 canvas.
- Reference: `themaphack-main/jni/XYZ/Minimap.h` `WorldToMinimap()` — same constants
  (`314.60` / `134.76`, `74.11`), `MapSize=341`, `StartPos=(105,0)`.
- **Corner window sizing:** keep the 720 logical canvas and CSS-scale to the corner box, or
  scale the profile proportionally. Don't recalibrate.

## 6. W2S / ESP — the definitive route

**Do NOT hand-roll the projection.** The original failure ("W2S only correct at map origin")
was exactly that: reimplementing a projection against MLBB's dynamic camera (SmoothFollow,
drag, death cam) with hardcoded FOV/aspect. The reader no longer attempts W2S at all
(`m2/cppport.cpp` has zero camera/projection code), which is why the old `overlay/`
`box` field renders nothing.

**The working route: call Unity's own `Camera.WorldToScreenPoint(Vector3)`.** Proven in
`themaphack-main`:

```cpp
// themaphack-main/jni/XYZ/GameClass.h
uintptr_t Camera_get_main() {
    return (uintptr_t) Il2CppGetMethodOffset("UnityEngine.CoreModule.dll", "UnityEngine", "Camera", "get_main");
}
uintptr_t Camera_WorldToScreenPoint() {
    return (uintptr_t) Il2CppGetMethodOffset("UnityEngine.CoreModule.dll", "UnityEngine", "Camera", "WorldToScreenPoint", 1);
}
Vector3 WorldToScreen(Vector3 position) {
    return reinterpret_cast<Vector3(__fastcall *)(void *, Vector3)>(Camera_WorldToScreenPoint())(get_main(), position);
}
```

Usage (`DrawESP.h` / `DrawMinimap.h`):

```cpp
auto rootPosVec2 = getPosVec2(_Position, screenWidth, screenHeight);
// getPosVec2:
auto p = WorldToScreen(_Position);
if (p.z > 0) return ImVec2(p.x, screenHeight - p.y);   // Unity origin is BOTTOM-LEFT
return ImVec2(screenWidth - p.x, p.y);                  // behind camera
```

Key points:
- **y-flip is mandatory** — Unity screen space origin is bottom-left, Android overlay is
  top-left.
- Camera instance = `UnityEngine.Camera.get_main()` (static property).
- Method resolved **by name** (`WorldToScreenPoint`, argc 1) — no RVA, survives patches and
  works on any arch (same principle as `invoke_battledata.js` resolving `RequestBattleData`
  by name).
- Screen size from `UnityEngine.Screen.get_width/get_height`.

**Two ways to apply it here:**
1. **Inside the game (internal, themaphack style):** requires injection/hooks — NOT our model
   (m2 is external). Avoid.
2. **External via frida `il2cpp_runtime_invoke`** on the reader session: resolve `Camera.main`
   (static getter) → `WorldToScreenPoint(pos)` for each unit → emit screen coords in the frame.
   This is a probe-time addon, not the runtime reader (the frida-free reader can't invoke
   managed methods). Acceptable because offsets refresh already uses frida.

**Recommendation:** if boxes are wanted, first do a one-shot frida spike
(`WorldToScreenPoint` for two known `m_v2RealPos` points, print pixels). Sane numbers ⇒
boxes are cheap and exact. Otherwise stay minimap-only.

### Related reference in themaphack
- `DrawMinimap.h` — game's own minimap icon API: `BattleBridge.SetMapEntityIconPos`,
  `SetMapInvisibility`, plus `CoordinateMap()` (hardcoded-scale variant; less exact than
  `Minimap.h`). Internal-only.
- `DrawESP.h` — entity field set used for boxes: `BattleManager.Instance`,
  `m_LocalPlayerShow`, `m_dicPlayerShow`, `m_dicMonsterShow`, `ShowEntity._Position`,
  `EntityBase.m_bSameCampType/m_bDeath/m_Hp/m_HpMax/m_ID`, `ShowPlayer.m_HeroName`,
  `m_iSummonSkillId`. Useful as a field-name cross-check for the reader's config, though the
  internal object graph differs from our external one.
- `Unity/Struct/{Vector3,Quaternion}`, `IconMinimap/*` (hero/monster/spell/rank icons).

## 7. Gotchas

- **`HEROES` table in `constants.js` is the known +1-shifted, stale one** (no ids >128; seen
  up to 294) and icons use `<heroId+1>.png`. Minimap portraits will be wrong until the real
  heroId→name/icon map is pulled from the game (BATTLEFIELD_FETCH open q #3).
- **`port.json` must match the install's build fingerprint** or slots come back empty
  (`PATCH_DAY_LESSONS` §7). Refresh from the laptop after each game patch.
- **FLAG_SECURE** blanks the overlay from your own screenshots/scrcpy too — debug via logs and
  `frame.json`, not capture.
- **Foreground gating:** a WM overlay isn't hidden on the lock screen by default, but also
  isn't restricted to the game. Hide unless `com.mobile.legends` is resumed.
- **Thermals:** clamp the WebView/JS redraw (30–60 FPS) like the browser overlay does.
- **SELinux:** the daemon's domain must be allowed to talk to the reader/`su`; app-owned
  `frame.json` avoids cross-domain file access.

## 8. Roadmap

1. `moba/www/web.html` — transparent corner minimap (reuse `coords.js`).
2. `overlay/` — WebView host sized to corner, FLAG_SECURE, settings (position/size/enable).
3. daemon — on-device reader spawn + pid discovery + `frame.json`.
4. validate: passthrough mid-match, secure vs scrcpy, minimap accuracy.
5. optional: W2S spike → ESP boxes (see §6).
