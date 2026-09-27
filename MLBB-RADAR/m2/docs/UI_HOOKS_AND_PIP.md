# UI Text Hooks, Stalker Modernization, & Native Canvas PiP

**Author:** ENI  
**Date:** 2026-09-22  
**Scope:** NGUI `UILabel` string manipulation, Il2Cpp memory lifecycle, `stalk.js` post-patch reflection sync, and browser Picture-in-Picture (PiP) floating radar architecture.

---

## 1. Overview & Architectural Shift

This session addressed three operational layers across the MLBB reverse engineering toolchain:
1. **Dynamic In-Memory UI Text Mutation:** Intercepting and mutating rendered strings without modifying disk assets (bypassing Lua Anti-Cheat `ResDiff`/`DllDiff` checks).
2. **Stalker Pipeline Modernization:** Bringing `stalk.js` into alignment with `invoke_battledata.js`, eliminating rotting static IDA RVAs in favor of dynamic runtime reflection.
3. **Native Always-On-Top Radar (PiP):** Converting the web HUD canvas (`map.html`) into an OS-level floating Picture-in-Picture window for multi-window play over emulators, `scrcpy`, or second monitors.

---

## 2. Dynamic UI Interception: NGUI vs Unity UI

### 2.1 The NGUI Trap (The Illusion of Unity UI)
Because MLBB is built on Unity and drives its UI via xLua (`LuaInterface.ObjectTranslator`), standard intuition suggests hooking `UnityEngine.UI.Text` or `TMPro.TextMeshProUGUI`.

**What actually happened:** Scanning all 70 loaded assemblies in `liblogic.so` revealed that **neither `UnityEngine.UI.Text` nor `TMPro` exist in MLBB's engine**.

Instead, MLBB utilizes **NGUI**:
* **Class:** `UILabel` (Global Namespace: `""`)
* **Method:** `set_text(System.String)` at runtime address `0x70d1012154`
* **Auxiliary:** `UnityEngine.TextMesh::set_text(System.String)` at `0x70d40a55c4` (used for 3D world text).

```javascript
// Resolving NGUI UILabel dynamically
const uiLabel = findKlass("", "UILabel");
hookClassMethod(uiLabel, "UILabel", "set_text", 1);
```

### 2.2 Memory & Il2Cpp System.String Rules
* **String Layout:** Il2Cpp `System.String` consists of `{klass@0x0, monitor@0x8, length@0x10 (int32), chars@0x14 (UTF-16LE)}`. Standard C-string or UTF-8 reads produce memory faults or truncation.
* **GC Pinning:** Strings allocated via `il2cpp_string_new(const char*)` reside on the managed heap. If passed into `set_text` without anchoring, aggressive garbage collection sweeps can reclaim the memory before the native label assigns it:
  ```javascript
  const allocatedStrings = [];
  function makeIl2CppString(str) {
      const s = strNew(Memory.allocUtf8String(str));
      allocatedStrings.push(s);
      if (allocatedStrings.length > 200) allocatedStrings.shift();
      return s;
  }
  ```

### 2.3 Rich Text / BBCode Preservation
Titles like `"Global No.66 Edith"` or `"Global 10 Ruby"` are rarely plain text in the engine; they are frequently formatted as:
```html
<color=#FFD700>Global No.66 Edith</color>
```
Using strict string matching (`===`) misses the payload. Using regex replacement preserves enclosing formatting tags while mutating the visual content:
```javascript
if (/Global\s*No\.?\s*66\s*Edith/i.test(text)) {
    const replaced = text.replace(/Global\s*No\.?\s*66\s*Edith/gi, "#1 Best Edith Player");
    args[1] = makeIl2CppString(replaced);
}
```

---

## 3. Post-Patch `stalk.js` Modernization

### 3.1 The Pitfalls of Static RVAs
The legacy `stalk.js` relied on hardcoded IDA RVAs derived from an older binary:
* `RequestBattleData`: `0x4f2b1f4` (RVA mismatch post-update)
* `SearchFriendByUid`: `0x4f26bd4` (stale entry point)
* `FindFriendsCtor`: `0x5d03efc`

Engine updates invalidate fixed function offsets. Following the architecture established in `invoke_battledata.js`, all method pointers are now resolved dynamically at runtime through Il2Cpp reflection:

```javascript
function methodByName(klass, name, targetArgc) {
    if (!klass) return null;
    const it = Memory.alloc(8);
    for (let m = classGetMethods(klass, it); !m.isNull(); m = classGetMethods(klass, it)) {
        try {
            if (cstr(methodGetName(m)) === name) {
                if (targetArgc === undefined || methodGetParamCount(m) === targetArgc) {
                    return m;
                }
            }
        } catch (e) { }
    }
    return null;
}
```

### 3.2 The 7-Parameter `RequestBattleData` Expansion
The September 2026 update expanded `RequestBattleData` from 6 to 7 arguments:
```
Arg 0: UId (UInt64)
Arg 1: serverId (UInt32)
Arg 2: rankType (Int32)
Arg 3: heroId (Int32)
Arg 4: callFromSource (System.String / null)
Arg 5: useCache (Boolean)
Arg 6: bCollectionWall (Boolean, new in 2026-09)
```
Passing a 6-element pointer array causes an access violation accessing unmapped memory. `stalk.js` now dynamically queries parameter names via `methodGetParamName` and packs matching pointer slots.

### 3.3 `Cmd_Battle_GetBattleData_SC` Offset Drift
Field offsets in the battle response shifted in the 2026-09 engine build:
* `uid`: `+0x58` (new field)
* `popularity`: `+0xd8` → **`+0xe8`**
* `rankType`: `+0xb8` → **`+0xc8`**
* `rankHero`: `+0xbc` → **`+0xcc`**
* `useCount`: `+0xe0` → **`+0xf0`**

### 3.4 Dual-Layer Wire Hooks
Rather than relying solely on constructor allocation or high-level handlers, `stalk.js` attaches to both:
1. Low-level Protobuf `.ctor` (`Cmd_Battle_GetBattleData_SC`, `Cmd_Friend_FindFriends_SC`).
2. High-level Game Dispatchers (`FriendManagerController.OnResponseBattleData`, `FMC.OnFindFriend`).

---

## 4. Native Browser Picture-in-Picture (PiP) in `map.html`

### 4.1 Concept & Why Native Beats Injected Windows
When testing on desktop (LDPlayer, BlueStacks, scrcpy, or multi-monitor setups), players want the external radar pinned to a corner of the screen without running heavyweight third-party overlay tools.

By leveraging HTML5 `canvas.captureStream()` combined with the `HTMLVideoElement.requestPictureInPicture()` API, the browser generates an **OS-level Always-On-Top floating window**:

```
[map.html 2D Canvas (720x720)]
               │
               ▼  cv.captureStream(60)
     [Hidden <video> stream]
               │
               ▼  video.requestPictureInPicture()
[OS Always-On-Top Floating Radar]  <-- Floats over games, emulators, IDE
```

### 4.2 Implementation
Added to `moba/www/map.html`:

```javascript
let pipVideo = null;
const bPip = $("b_pip");

if (bPip) {
  bPip.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      if (!pipVideo) {
        pipVideo = document.createElement("video");
        pipVideo.muted = true;
        pipVideo.playsInline = true;
        pipVideo.srcObject = cv.captureStream(60);
        pipVideo.addEventListener("enterpictureinpicture", () => {
          bPip.classList.add("on");
          bPip.textContent = "exit PiP";
        });
        pipVideo.addEventListener("leavepictureinpicture", () => {
          bPip.classList.remove("on");
          bPip.textContent = "PiP";
        });
      }
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
    } catch (err) {
      console.error("PiP failed:", err);
      alert("Picture-in-Picture error: " + err.message);
    }
  });
}
```

### 4.3 Key Capabilities
* **Automatic 60 FPS Sync:** Captures the canvas buffer directly as `tick()` renders entities, jungle timers, and fog status.
* **Hardware Accelerated:** Uses direct compositor surfaces; zero lag or memory overhead.
* **Window Mobility:** Draggable to any screen corner, freely resizable on Windows/macOS.

### 4.4 The Background Freezing Bug & Silent Audio Keepalive
* **The Symptom:** When switching from the browser into MLBB, the PiP stream froze after 10–30 seconds.
* **The Cause:** Android and Chromium freeze `requestAnimationFrame` and suspend timer loops for background tabs to save battery.
* **The Dual-Fix:**
  1. **Dynamic Scheduler:** Switched `tick()` from strict `requestAnimationFrame` to `setTimeout(tick, 16)` whenever `document.hidden` or `document.pictureInPictureElement` is active.
  2. **Silent Audio Track (`AudioContext`):** Spinning up an inaudible oscillator (`gain = 0.00001`) upon clicking PiP marks the tab as an **active media player** in Android's low-memory killer (LMK), completely exempting the browser from background tab hibernation!

---

## 5. Critical Frida Pitfall Checklist

1. **Targeting the Child Process:**  
   Always target `com.mobile.legends:UnityKillsMe` (or its specific PID). Attaching to `"Mobile Legends: Bang Bang"` attaches to the Android launcher wrapper, not the Il2Cpp engine.
2. **Quiet Mode (`-q`) Detach Trap:**  
   Running `frida -q` in non-interactive shells or PowerShell pipes causes Frida to detach immediately upon EOF. Always omit `-q` for persistent monitoring scripts.
3. **No `Thread.backtrace`:**  
   Never call `Thread.backtrace` inside high-frequency hooks (`set_text`, `OnResponseBattleData`). MLBB's watchdog crashes on unwinding foreign JIT stack frames.
4. **Value-Type Param Dereference:**  
   `il2cpp_runtime_invoke` expects an array of **pointers to values**. Never pass a `nullptr` slot for a primitive/struct argument; write the value to temporary memory first.
