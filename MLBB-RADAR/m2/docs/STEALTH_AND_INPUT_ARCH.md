# Stealth, Input Architecture, and Sandbox Realities

**Author:** ENI & LO  
**Date:** 2026-09-23  
**Target:** Samsung Galaxy A35 (Exynos 1380 / One UI 6 / Android 14, API 34)  
**Scope:** SurfaceFlinger stealth rendering, Linux input mechanics, sandbox isolation auditing, and memory reading footprints.

---

## 1. The Screenshot Dilemma: `FLAG_SECURE` vs. `eLayerSkipScreenshot`

### The Trap: Why `FLAG_SECURE` (`setSecure`) Failed
When an overlay or window sets `FLAG_SECURE` (`setSecure(true)` via `SurfaceControl.Transaction` or WindowManager):
1. SurfaceFlinger tags the native layer state with **`eLayerSecure` (`0x80`)**.
2. When the user takes a screenshot on Samsung One UI (Power + Volume Down, Palm Swipe, or Smart Capture), Samsung's `ScreenshotHelper` / Knox security policy scans the active layer tree.
3. If **any** active layer asserts `isSecure() == true`, Knox immediately **aborts the screenshot**, displaying:
   > *"Can't take screenshot due to security policy"*
4. This completely breaks the user experience: screenshots are disabled system-wide.

### The Fix: `eLayerSkipScreenshot` (`0x00000040`)
Low-level native overlays (like the investigated `AImGui` daemon) achieve clean screenshots **without** triggering Knox policy blocks by using `eLayerSkipScreenshot`:

```text
SurfaceFlinger Layer State Flags (LayerState.h):
  eLayerHidden          = 0x00000001
  eLayerOpaque          = 0x00000002
  eLayerSkipScreenshot  = 0x00000040
  eLayerSecure          = 0x00000080
```

In Android 13 and 14, this is exposed in the hidden framework API:
```java
// android.view.SurfaceControl.Transaction (AOSP @hide)
public Transaction setSkipScreenshot(SurfaceControl sc, boolean skipScrenshot) {
    checkPreconditions(sc);
    if (skipScrenshot) {
        nativeSetFlags(mNativeObject, sc.mNativeObject, SKIP_SCREENSHOT, SKIP_SCREENSHOT);
    } else {
        nativeSetFlags(mNativeObject, sc.mNativeObject, 0, SKIP_SCREENSHOT);
    }
    return this;
}
```

### The Architectural Difference
* **Knox Security Check:** Knox only checks `isSecure()`. Because `isSecure` remains `false`, Knox permits the screenshot to proceed.
* **SurfaceFlinger Render Pipeline:** When SurfaceFlinger composes frames for an offscreen capture target (`captureLayers` / `captureDisplay` / `screencap` / `MediaProjection`), it checks `layer->isSkipScreenshot()`.
* **Result:** SurfaceFlinger silently filters out the overlay layer from the output buffer while rendering everything beneath it. The screenshot captures cleanly with zero overlay and zero policy warnings.

#### Verified SurfaceFlinger Dump on Galaxy A35:
```text
Layer (NightShift_SF#78023) uid=0
  layerStack= 0, z=2147483647, isTrustedOverlay=1, isSecure=false, flags=0x00000040
```

---

## 2. Touch Automation & The Linux Input Subsystem

### Why Writing Directly to `/dev/input/eventX` Breaks Mobile Games
Root access allows opening the physical touchscreen character device (e.g. `/dev/input/event4` on Samsung) with `O_WRONLY`. However, doing this during active gameplay causes catastrophic failures due to **Linux Multi-Touch Protocol Type B** state desynchronization:

1. **Slot Collision (`ABS_MT_SLOT`):**
   * The digitizer driver assigns active fingers to slots (Slot 0 to Slot 9).
   * If a player is holding down the virtual movement joystick on Slot 0 and an external script writes to Slot 0, the kernel input accumulator clobbers the joystick tracking, causing joystick drops or sudden coordinate teleportation.
2. **Torn Packets (`SYN_REPORT` Interleaving):**
   * Hardware interrupts and synthetic writes share the same character device FIFO buffer.
   * If a synthetic packet injects mid-frame, `ABS_MT_POSITION` values interleave with hardware values before `SYN_REPORT`, producing corrupt coordinates and ghost touches.
3. **Hardware Re-Assertion:**
   * The capacitive panel scans at 120Hz–360Hz. If software injects an artificial `ACTION_UP` (`ABS_MT_TRACKING_ID -1`) while a finger is physically on the glass, the digitizer re-asserts `ACTION_DOWN` within 4–8ms, resulting in double-taps or aborted gestures.
4. **`EVIOCGRAB` Lockout:**
   * Calling `ioctl(fd, EVIOCGRAB, 1)` disconnects all physical hardware events from Android `InputReader`, freezing the player's physical touch controls entirely during injection.

### The Solution: Virtual Input via `/dev/uinput`
Sophisticated automation engines use `/dev/uinput` instead:
* Creates an independent virtual input device with its own isolated slot table.
* Android's `InputDispatcher` natively handles multi-device aggregation, merging touches from the virtual device with physical thumbs smoothly without state corruption.

### Detection Dynamics & Kinematics
* **Can apps detect `/dev/uinput`?**
  * Yes: `MotionEvent.getDeviceId()` points to a device declaring `InputDevice.getBusType() == BUS_VIRTUAL` (`0x06`), and `/proc/bus/input/devices` is world-readable.
* **Why anti-cheats don't ban solely on `uinput` existence:**
  * Samsung DeX, Bluetooth controllers (Xbox/PS5), USB-C docks, and accessibility tools legitimately register virtual input devices on `BUS_VIRTUAL`. Banning on the presence of a virtual device causes massive false positives.
* **The Real Tripwire (Kinematic & Timing Heuristics):**
  * Anti-cheat algorithms monitor touch physics: analog pressure curves (`AXIS_PRESSURE` ramping 0.2 $\rightarrow$ 0.8 $\rightarrow$ 0.0), contact ellipsoids (`AXIS_TOUCH_MAJOR` / `MINOR`), and physiological micro-tremor (1–3 px oscillation).
  * Automated triggers (e.g. instant smite/Retribution the exact millisecond creep HP drops below threshold with zero visual reaction latency) are flagged via statistical variance tests ($\sigma^2 \approx 0$).

---

## 3. Debunking the `/proc/self/fd/` Memory Reader Myth

### The False Assertion
> *"While open, the target game process can detect an external reader by checking its own `/proc/self/fd/` links to see that an external process has an active handle pointing into its memory space."*

### Why It Is Architecturally Impossible
1. **Private File Descriptor Tables (`files_struct`):**
   * A process’s `/proc/self/fd/` (symlinking to `/proc/<pid>/fd/`) represents **its own private file descriptor table**.
   * When an external root reader (`cppport`, PID 23520) calls `open("/proc/9958/mem", O_RDONLY)`, `fd 3` is allocated in **`cppport`'s** file table (`/proc/23520/fd/3`).
   * It is never added to the target game's file descriptor table. The target game’s `/proc/self/fd/` contains only files the game itself opened.
2. **Access Control Blocks Cross-PID Inspection:**
   * The target game cannot inspect `/proc/<reader_pid>/fd/`:
     * **DAC:** `/proc/<root_pid>/fd/` has `0500` (`dr-x------`) permissions owned by `root`. Unprivileged app UIDs get `EACCES`.
     * **SELinux:** Android’s `untrusted_app` domain is barred from accessing proc nodes of other domains.
3. **`process_vm_readv` Leaves Zero File Descriptors:**
   * In `cppport.cpp`, the primary memory reading path uses `process_vm_readv()`:
     ```cpp
     if (process_vm_readv(pid, &local, 1, &remote, 1, 0) == static_cast<ssize_t>(len)) return true;
     ```
   * `process_vm_readv` is a zero-copy Linux syscall (`__NR_process_vm_readv = 270`). It transfers bytes directly between virtual memory address spaces inside kernel space without allocating an `fd`, opening `/proc/<pid>/mem`, or touching the filesystem.

---

## 4. Sandbox Auditing & Hardening `/data/local/tmp`

### The Real Exposure: The `0771` Directory Permission Trap
By dropping into the game’s exact UID context (`u0_a412` / UID `10412`) on the Galaxy A35, we audited what an unprivileged app could actually see:

```text
# Initial audit results from UID 10412:
Target: /data/local/tmp/m2.cfg        -> [READABLE] Full cheat config with class offsets!
Target: /data/local/tmp/.audio_mixer  -> [READABLE] Entire 5.95 MB ARM64 ELF binary!
Target: /data/local/tmp/nightshift.dex-> [READABLE] Java DEX bytecode!
Target: /data/local/tmp/frame.json    -> [READABLE] Real-time JSON telemetry!
Target: /data/local/tmp/              -> ls: Permission denied
```

#### Why this happened:
* Standard `/data/local/tmp` directory permissions are `0771` (`drwxrwx--x`), owned by `shell:shell`.
* Unprivileged apps have **execute (`x`)** permission, but **no read (`r`)** permission:
  * The app **cannot list** `/data/local/tmp/` blindly (`readdir()` fails).
  * However, if the anti-cheat has **hardcoded path signatures** (e.g. `open("/data/local/tmp/m2.cfg", O_RDONLY)`), path traversal succeeds, and any world-readable file can be opened and parsed.

### The Lockdown Fix
We applied strict directory-level and file-level hardening:

1. **Sealed Directory Traversal (`chmod 770 /data/local/tmp`):**
   * Removing the `--x` permission from `other` locks out all non-shell, non-root processes.
   * `shell` (ADB UID 2000) and `root` (UID 0) retain full `rwx` access.
   * Untrusted apps (`u0_a...`) receive `EACCES` on any attempt to enter or query `/data/local/tmp/`.
2. **File Inode Hardening (`0700` / `0600`):**
   * Executables and scripts: `chmod 700` (`-rwx------`), owned by `root:root`.
   * Data and config files: `chmod 600` (`-rw-------`), owned by `root:root`.
3. **Automated Enforcement:**
   * Both `start_sf.sh` and `run_reader.sh` enforce `umask 077` and execute `chmod 770 /data/local/tmp` at startup so that newly written frames or logs inherit non-world-readable permissions automatically.

#### Post-Hardening Verification from MLBB UID (`10412`):
```text
Target: /data/local/tmp/frame.json    -> cat: Permission denied
Target: /data/local/tmp/m2.cfg        -> cat: Permission denied
Target: /data/local/tmp/.audio_mixer  -> cat: Permission denied
Target: /data/local/tmp/nightshift.dex-> cat: Permission denied
Target: /data/local/tmp/              -> ls: Permission denied
```

---

## 5. `serve.py` Handshake & Lifecycle Diagnostics

### Why `http://127.0.0.1:8080/map.json` Reads Empty on Startup
In `serve.py`, the internal state is initialized to:
```python
LATEST = "{}"
```
When `start_sf.sh` or `serve.py` kicks the reader:
1. **Process Discovery:** The runner waits for `com.mobile.legends:UnityKillsMe` to initialize.
2. **Il2Cpp Resolution:** The reader walks the static pointer chain:
   $$\text{BattleData.m\_BattleBridge} \longrightarrow \text{BattleManager.Instance} \longrightarrow \text{m\_LocalPlayerShow}$$
3. **Match State Detection:** During match loading or pre-spawn, `bm` may exist, but `self` is null (`self < 0x1000`), meaning the match is not yet active.
4. **First Frame:** The server only overwrites `LATEST` once the first valid frame line starting with `{` is received from the reader’s stdout.
5. Until that first valid frame completes, any HTTP client requesting `/map.json` receives the initial empty string `{}`. Once `self` resolves, the entity stream updates continuously at 60Hz.
