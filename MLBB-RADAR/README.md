# MLBB Radar & Replay Studio

External, zero-overhead memory telemetry engine and web-based tactical radar HUD for *Mobile Legends: Bang Bang*.

---

## ⚡ How It Works

- **FRIDALESS at Runtime**: During live matches, the game process is **NEVER** hooked or injected.
- **External C++ Reader**: A standalone aarch64 ELF binary (`.audio_mixer`) runs as `root` in `/data/local/tmp` and reads game memory externally using the Linux kernel's `process_vm_readv` syscall.
- **Web Minimap HUD**: Telemetry is streamed to a local Python daemon (`serve.py`) on port `8080`, providing real-time 60 FPS HTML5 minimap rendering and automated match recording.

---

## 📁 Repository Layout

```
MLBB-RADAR/
├── start.cmd              # Double-click launcher (Windows)
├── m2/                    # Core active toolchain
│   ├── cppport.cpp        # Root C++ memory reader source
│   ├── build.sh           # NDK cross-compilation script
│   ├── .audio_mixer       # Pre-compiled aarch64 binary
│   ├── port.json          # Il2Cpp class structures & struct offsets
│   ├── cfgkeys.py         # Config generator from port.json
│   ├── m2.cfg             # Emitted config stream
│   ├── serve.py           # Stream runner & HTTP server (:8080)
│   ├── tools.py           # Developer Swiss-Army CLI
│   ├── paths.py           # Canonical path definitions
│   ├── adb.py             # Device discovery & ADB abstraction
│   ├── rescue_replay.py   # Tool to fix corrupted replay JSONs
│   ├── docs/              # Deep-dive architecture and offset guides
│   └── replays/           # Saved .mreplay match files
├── www/                   # Web frontend assets
│   ├── map.html           # Live radar HUD (fog rings, spells, timers, PiP)
│   ├── replay.html        # Replay & rotation studio
│   ├── map.png            # Minimap base texture
│   ├── map_red.png        # Red-side flipped minimap texture
│   ├── replay/            # Replay engine, timeline & coaching pen
│   ├── src/               # Shared radar rendering & tactical analysis
│   └── mlbbicons/         # Hero icon atlas
└── frida/                 # Offline reconnaissance scripts (for patch updates)
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Device**: Physical rooted Android phone (KernelSU or Magisk) with USB debugging enabled.
- **PC**: Python 3.10+ and ADB installed and in your system `PATH`.

### 2. Run the Radar
1. Connect phone via USB (or wireless ADB).
2. Launch Mobile Legends on the phone and enter a match.
3. On your PC, double-click **`start.cmd`** (or run `cd m2 && python -u serve.py`).
4. Open your browser:
   - **Live Radar HUD**: [http://localhost:8080/map.html](http://localhost:8080/map.html)
   - **Replay Studio**: [http://localhost:8080/replay.html](http://localhost:8080/replay.html)

*(To access from phone or second monitor on LAN/Tailscale, replace `localhost` with your PC's LAN or Tailscale IP).*

---

## 🛠️ Rebuilding the C++ Reader (When Game Updates)

If game patches change offsets:
1. Update `m2/port.json` with new offsets.
2. Compile the reader via Android NDK (WSL / Linux):
   ```bash
   cd m2
   bash build.sh
   ```
3. Test syntax without full build:
   ```bash
   bash build.sh --check
   ```
