# M2 Architecture: What Is It & What To Do With It

**A Definitive Field Guide, Directory Map, and Operational Runbook for AI Agents**  
**Author:** ENI & LO  
**Scope:** `moba/m2/`, `moba/www/`, `moba/frida/`, Android Root Telemetry, and Cross-Platform Tooling

---

## 1. The 30-Second Mental Model

1. **What is this project?**  
   A zero-overhead, external memory telemetry engine and web-based tactical radar for *Mobile Legends: Bang Bang* running on a physical rooted Samsung Galaxy A35 (`SM-A356E`, Exynos 1380, Android 14, KernelSU).

2. **The Golden Architecture Rule:**  
   **Runtime is FRIDALESS.**  
   During live matches, the game process (`com.mobile.legends:UnityKillsMe`) is NEVER hooked. Zero code injection, zero breakpoints, zero Frida agent in memory. All telemetry is acquired externally by a standalone C++ ELF binary (`.audio_mixer`) running as `root` in `/data/local/tmp` using Linux `process_vm_readv` (direct kernel virtual memory copy).

3. **Where does Frida fit in?**  
   **Frida is for RECON ONLY.**  
   Frida (via `logd-helper` running on port `27043`) is strictly used offline or in practice mode to resolve struct offsets, probe class memory layouts, or reverse-engineer engine flags (such as finding `m_MainTowerDead`). Once offsets are known, they are written to `port.json` and consumed by the C++ reader.

4. **Directory Separation:**  
   * **`moba/m2/`**: **THE ACTIVE TOOLCHAIN.** Clean, modular C++, Python orchestrators, offset generators, and documentation. All new development happens here.
   * **`moba/www/`**: Web UI assets (`map.html` radar, `replay.html` studio, `draft.json` cache).
   * **`moba/frida/`**: Standalone JavaScript recon probes and reverse-engineering scripts.
   * **`moba/` (root)**: Legacy prototypes and earlier experimental attempts. **DO NOT MODIFY** unless explicitly instructed.
   * **`KernelFolder/` / `KernelFiles/`**: Linux kernel and KernelSU sources for the A35 device. Unrelated to the MOBA radar.

---

## 2. Directory & File Inventory: "What Is It?"

### 2.1 The `moba/m2/` Toolchain (The Core)

| File | What It Is | Role & Responsibility |
|---|---|---|
| **`cppport.cpp`** | **The Root C++ Reader** | Single C++20 source file compiled into `/data/local/tmp/.audio_mixer`. Attaches to engine PID, parses `process_vm_readv` memory reads, traverses Il2Cpp entity pools, decodes coordinates, HP, summons, and emits compact NDJSON frames to `stdout`. |
| **`build.sh`** | **NDK Cross-Compiler** | Bash script executed via WSL. Uses Android NDK r29 clang++ (`aarch64-linux-android35-clang++`) to compile `cppport.cpp` with `-std=c++20 -O2 -static-libstdc++`. Supports `--check` for fast syntax validation. |
| **`.audio_mixer`** | **Reader Binary** | The compiled aarch64 ELF binary. Named innocuously (`.audio_mixer`) to blend in under `/data/local/tmp/`. Pushed to device and executed via `su -c`. |
| **`port.json`** | **Offset Schema** | The canonical JSON database of all Il2Cpp class structures, static field pointers, field offsets, list/dict memory layouts, and build fingerprints. |
| **`cfgkeys.py`** | **Config Generator** | **Single Source of Truth** for configuration stream generation. Reads `port.json` and emits `key=val` lines that `cppport.cpp` understands (e.g. `inst.BattleManager.m_MainTowerDead=128`). Never hardcode configs anywhere else! |
| **`m2.cfg`** | **Config Cache** | Text file output of `cfgkeys.emit()`. Can be loaded directly by `cppport` or streamed via stdin. |
| **`port2config.py`** | **Config CLI Wrapper** | Command-line bridge: `python port2config.py port.json > m2.cfg`. |
| **`serve.py`** | **Unified Orchestrator** | Long-running Python daemon. Deploys binary, launches `.audio_mixer` on target PID via ADB, hosts HTTP server on `:8080`, persists drafts to `www/draft.json`, and automatically saves match recordings (`.mreplay`) to `m2/replays/`. |
| **`tools.py`** | **Developer Swiss-Army Knife** | Command-line utility for dev workflows: `status`, `selftest`, `once`, `debug`, `build`, `check`, `deploy`, `refresh`, `frida`, `wireless`. |
| **`paths.py`** | **Anchor Constants** | System path registry (`ROOT`, `PORT_JSON`, `READER_BIN`, `WWW_DIR`, `REPLAYS`, etc.). Always import paths from here! |
| **`adb.py`** | **Device Bridge** | Manages ADB connections, device discovery (`RRCX606CW4E`), Wi-Fi pairing/connect, and automatic lookup of the engine child process (`com.mobile.legends:UnityKillsMe`). |
| **`replays/`** | **Match Storage** | Directory containing `.mreplay` files automatically recorded by `serve.py` or saved from `replay.html`. |
| **`docs/`** | **Technical Documentation** | Architectural guides, memory layouts, lesson learned, and implementation handoffs. |

### 2.2 The `moba/www/` Frontend

| File | What It Is | Role & Responsibility |
|---|---|---|
| **`map.html`** | **Live Radar Canvas HUD** | High-performance HTML5 canvas minimap. Polls `/map.json` at 60 FPS, renders hero icons, health bars, fog rings, vision cones, jungle camp respawn timers, and floating battle spell cooldowns. Supports Picture-in-Picture (PiP). |
| **`replay.html`** | **Replay & Rotation Studio** | Standalone match analyzer. Loads `.mreplay` files or demo data. Features timeline scrubber, speed multipliers (0.25x–8x), step jumps, and perspective switching (Oracle God View vs. Player Fog of War View). |
| **`draft.json`** | **Persistent Draft Cache** | Persistent JSON store of hero picks, bans, player names, and summon spells. Written by `serve.py` whenever draft data appears in telemetry; never wiped on match end or client restart. |
| **`src/`** | **Shared JS Modules** | Supporting scripts (`app.js`, `draft.js`, `pip.js`, `settings.js`) used by the web interfaces. |

### 2.3 The `moba/frida/` Probing Sandbox

| File | What It Is | Role & Responsibility |
|---|---|---|
| **`battle_state_probe.js`** | **Match Lifecycle Probe** | Dumps live fields of `BattleManager` and `LogicBattleManager` to reverse-engineer match completion states. |
| **`sample_clock.js`** | **Clock Stability Probe** | Samples high-frequency engine frame timers (`m_uiFrameTime`, `m_ulFrameTime`) to analyze simulation tick pauses. |
| **`live_bm_test.js`** | **Targeted Field Inspector** | Reads specific offsets (e.g. `+128` for `m_MainTowerDead`) in real-time. |
| **`stalk.js`** | **Instruction Tracer** | Stalker script for deep method and instruction tracing. |

---

## 3. End-to-End Data Pipeline: How Data Flows

```
+-----------------------------------------------------------------------------------+
|               PHYSICAL TARGET: Samsung Galaxy A35 (KernelSU Root)                 |
|                                                                                   |
|  [Game Process: com.mobile.legends:UnityKillsMe (e.g. PID 5724)]                  |
|    - libil2cpp.so: BattleManager, LogicBattleManager, ShowPlayer, ShowEntity      |
|                                    ^                                              |
|                                    | process_vm_readv() (Zero hooks, pure read)   |
|                                    |                                              |
|  [External Daemon: /data/local/tmp/.audio_mixer <pid> <interval_ms>]              |
|    - Reads config from stdin or file (keys from cfgkeys.py)                       |
|    - Resolves pointers: BattleManager -> LocalPlayer -> EntityList               |
|    - Evaluates: inBattle = (bm && self >= 0x1000 && !m_MainTowerDead)             |
|    - Emits NDJSON frame to stdout: {"t":..., "gt":..., "bm":1, "heroes":[...]}    |
+-----------------------------------------------------------------------------------+
                                         |
                                         | stdout over ADB pipe (`adb shell su -c ...`)
                                         v
+-----------------------------------------------------------------------------------+
|               HOST MACHINE: Windows 11 / Python 3.14 (moba/m2/)                   |
|                                                                                   |
|  [Orchestrator: serve.py]                                                         |
|    - Deduplicates & buffers latest frame into LATEST                              |
|    - If frame has "draft": -> writes to moba/www/draft.json & updates LATEST_DRAFT|
|    - Auto-Recorder: if "bm": 1 -> buffers frames; if "bm": 0 -> saves .mreplay   |
|    - HTTP Server (:8080):                                                         |
|        * GET  /map.json       -> Streams live LATEST frame                        |
|        * GET  /draft.json     -> Serves persistent draft                          |
|        * GET  /replays        -> Lists saved match recordings                     |
|        * GET  /replay.json    -> Downloads specific .mreplay                      |
|        * POST /save_replay    -> Saves web-recorded replays                       |
+-----------------------------------------------------------------------------------+
                                         |
                                         | HTTP / WebSocket / Canvas Render
                                         v
+-----------------------------------------------------------------------------------+
|               BROWSER CLIENTS (Chrome / Overlay / PiP Window)                     |
|                                                                                   |
|  [map.html (Live Minimap)]             [replay.html (Replay Studio)]              |
|    - 60 FPS Canvas Render                - Scrubber timeline, 0.25x-8x playback    |
|    - Real-time enemy/jungle radar        - Fog of War vs Oracle vision toggles     |
|    - Sticky persistent draft drawer      - Teamfight & rotation post-mortem        |
+-----------------------------------------------------------------------------------+
```

---

## 4. Operational Runbooks: "What To Do With It"

### Runbook 1: Adding or Updating an Offset / Memory Field

**Scenario:** You need to read a new field from an Il2Cpp class (e.g. `m_MainTowerDead` at `BattleManager + 128`).

1. **Step 1: Register in `port.json`**
   Open [port.json](file:///c:/Users/berni/Desktop/a35project/moba/m2/port.json), find the class under `"classes"`, and add the field:
   ```json
   "m_MainTowerDead": {
     "offset": 128,
     "type": "System.Boolean",
     "isStatic": false
   }
   ```

2. **Step 2: Emit in `cfgkeys.py`**
   Open [cfgkeys.py](file:///c:/Users/berni/Desktop/a35project/moba/m2/cfgkeys.py) and add the field emitter in `emit()`:
   ```python
   ins("BattleManager", "m_MainTowerDead")
   ```
   *Verify:* Run `python -c "import paths, cfgkeys; print([l for l in cfgkeys.emit(cfgkeys.load(paths.PORT_JSON)).splitlines() if 'MainTower' in l])"` -> should output `['inst.BattleManager.m_MainTowerDead=128']`.

3. **Step 3: Update `cppport.cpp`**
   Open [cppport.cpp](file:///c:/Users/berni/Desktop/a35project/moba/m2/cppport.cpp):
   * Add field to `struct Config`:
     ```cpp
     int32_t bm_maintowerdead = 128; // default fallback
     ```
   * Parse the key in `Config::loadFromStream()`:
     ```cpp
     else if (key == "inst.BattleManager.m_MainTowerDead") bm_maintowerdead = static_cast<int32_t>(val);
     ```
   * Use the value in `renderFrame()`:
     ```cpp
     uint8_t towerDead = 0;
     if (bm && cfg.bm_maintowerdead >= 0) mem.read(bm + cfg.bm_maintowerdead, towerDead);
     bool inBattle = (bm && self >= 0x1000 && !towerDead);
     ```

4. **Step 4: Cross-Compile via WSL**
   Run syntax check and full build:
   ```powershell
   wsl -- bash -c "bash /mnt/c/Users/berni/Desktop/a35project/moba/m2/build.sh --check"
   wsl -- bash -c "bash /mnt/c/Users/berni/Desktop/a35project/moba/m2/build.sh"
   ```

5. **Step 5: Deploy & Test Live**
   Deploy and run a bounded snapshot test:
   ```powershell
   adb push .audio_mixer /data/local/tmp/.audio_mixer
   adb shell su -c "chmod 755 /data/local/tmp/.audio_mixer"
   python tools.py once 100 1.5
   ```

---

### Runbook 2: Investigating an Unknown Class or Field via Frida

**Scenario:** You need to find where game outcome, hero states, or invisible timers are stored.

1. **Check Frida Forwarding:**
   Ensure `logd-helper` is running on the device and forwarded to host:
   ```powershell
   adb forward tcp:27043 tcp:27043
   ```
   *Verify:* Device manager should find `127.0.0.1:27043`.

2. **Locate Target Process PID:**
   ```powershell
   python -c "import adb; print(adb.newest_child())"
   # -> (5724, 'com.mobile.legends:UnityKillsMe')
   ```

3. **Create a Minimal Probe Script in `moba/frida/`:**
   ```javascript
   // example: moba/frida/probe_field.js
   const il2cpp = Process.findModuleByName("libil2cpp.so");
   // Attach to method or inspect pointer:
   console.log("[*] libil2cpp base:", il2cpp.base);
   ```

4. **Execute using Python or Frida CLI:**
   ```powershell
   frida -H 127.0.0.1:27043 -p 5724 -l .\frida\probe_field.js
   ```

5. **Transfer Findings to `port.json`:**
   Once confirmed, record the exact offset and struct type into `port.json`. **Do not leave the Frida hook running during actual games.**

---

### Runbook 3: Running the Full Live Radar Service

**Scenario:** Preparing for a live match session.

1. **Start the Unified Server:**
   ```powershell
   cd c:\Users\berni\Desktop\a35project\moba\m2
   python serve.py
   ```
   *What `serve.py` does automatically:*
   * Connects to device via ADB (USB or Wi-Fi).
   * Deploys `.audio_mixer` to `/data/local/tmp/.audio_mixer`.
   * Waits for `com.mobile.legends:UnityKillsMe` to start.
   * Attaches root reader and begins streaming NDJSON.
   * Serves web dashboard on `http://127.0.0.1:8080/map.html`.
   * Automatically saves matches to `replays/<timestamp>_<hero>.mreplay`.

2. **Accessing Frontends:**
   * **Live Radar:** Open `http://localhost:8080/map.html`.
   * **Replay Studio:** Open `http://localhost:8080/replay.html`.
   * **Draft Intel:** Check `http://localhost:8080/draft.json`.
   * **Health Check:** Check `http://localhost:8080/health`.

---

## 5. Critical Traps & Agent Golden Rules

> [!CAUTION]
> **Trap 1: The Windows PowerShell UTF-16 Output Bug**  
> In Windows PowerShell, redirection (`python script.py > file.txt`) outputs **UTF-16 LE** with a Byte Order Mark (BOM). C++ and standard Linux tools will fail to parse this.  
> **Always write files in Python** with `open(file, 'w', encoding='utf-8', newline='\n')`.

> [!CAUTION]
> **Trap 2: PowerShell Command Chaining**  
> PowerShell 5.1 does **NOT** support `&&`. Running `cmd1 && cmd2` throws a parse error.  
> **Use:** `cmd1; if ($?) { cmd2 }` or execute separate commands.

> [!IMPORTANT]
> **Trap 3: NDK Cross-Compilation Must Use WSL**  
> Do **NOT** attempt to compile `.audio_mixer` with Windows MSVC, MinGW, or host Clang. It must be built as an Android aarch64 ELF binary using Android NDK r29 in WSL:  
> `/home/screen/android-ndk-r29/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang++`.

> [!IMPORTANT]
> **Trap 4: Never Put Runtime Hooks in Live Matches**  
> Mobile Legends uses anti-tamper memory watchdogs that detect active code hooks and debugger breakpoints. The external memory reader (`process_vm_readv`) is completely invisible and zero-risk. Keep it that way.

> [!TIP]
> **Trap 5: The Draft Clearing Bug**  
> Never overwrite `draft.json` or `LATEST_DRAFT` with `{}`. When match loading begins (`bm: 1`), draft data temporarily stops streaming. The server and web UI must retain the persistent draft so players can reference enemy spells throughout the entire game.

---

## 6. Quick Cheat Sheet for Common Commands

```powershell
# Check device, engine PID, and port.json health
python tools.py status

# Run reader for 1.5 seconds and display parsed JSON frame
python tools.py once 100 1.5

# Check C++ syntax without compiling
wsl -- bash -c "bash /mnt/c/Users/berni/Desktop/a35project/moba/m2/build.sh --check"

# Full compile of .audio_mixer
wsl -- bash -c "bash /mnt/c/Users/berni/Desktop/a35project/moba/m2/build.sh"

# Push reader to phone
adb push .audio_mixer /data/local/tmp/.audio_mixer; adb shell su -c "chmod 755 /data/local/tmp/.audio_mixer"

# Regenerate config from port.json with UTF-8
python -c "import cfgkeys, json; open('m2.cfg', 'w', encoding='utf-8', newline='\n').write(cfgkeys.emit(json.load(open('port.json', encoding='utf-8'))))"

# Start the full web server and telemetry pipeline
python serve.py
```
