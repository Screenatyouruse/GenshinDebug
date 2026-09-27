# Offline Reverse Engineering & Offset Probing

> ⚠️ **RULE**: Frida is for **OFFLINE RECON ONLY** (in practice / custom lobby).  
> During real matches, runtime is **100% FRIDALESS** (the C++ reader uses `process_vm_readv` externally). Never leave Frida hooks attached during competitive games.

---

## 🛠️ Key Reversal Scripts

| Script | Purpose | Usage |
|---|---|---|
| **`offsets.js`** | **The Main Offset Extractor**. Built on `frida-il2cpp-bridge`. Scans `liblogic.so` / `libunity.so`, discovers all engine classes (`BattleManager`, `RoleShow`, `RoomData`, etc.), extracts struct field offsets, and outputs `port.json`. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l offsets.js --runtime qjs` |
| **`offsets.ts`** | TypeScript source code for `offsets.js`. Edit this when adding new classes or fields to the scan list. | Compile with `npm run build` in `mlbb-bridge`. |
| **`dump_raw.js`** | Fast, lightweight C-API offset dumper. Calls raw Il2Cpp exports without high-level bridge overhead (~20 seconds runtime). | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l dump_raw.js --runtime qjs` |
| **`classfields.js`** | Runtime inspection tool. Prints all fields, types, and byte offsets for any chosen Il2Cpp class. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l classfields.js --runtime qjs` |
| **`room_dump.js`** | Deep draft and match lobby structure dumper. Reflects `RoomData` slots, bans, and hero picks. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l room_dump.js --runtime qjs` |
| **`battledata_probe.js`** | Monitors and logs BattleData network responses and combat statistics. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l battledata_probe.js --runtime qjs` |
| **`lua_text.js`** | Intercepts game Lua print/log functions and string tables to trace in-game events and logic flags. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l lua_text.js --runtime qjs` |
| **`findfriends_probe.js`** | Probes profile info, friend lookups, and account stat structures. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l findfriends_probe.js --runtime qjs` |
| **`idamap.js`** | Generates address/symbol mapping to cross-reference runtime pointers with IDA Pro / Ghidra disassemblies. | `frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l idamap.js --runtime qjs` |

---

## ⚡ Offset Refresh Runbook (When a Game Patch Drops)

When Mobile Legends updates its APK or `liblogic.so` / `libil2cpp.so`:

1. **Start frida-server on the device**:
   ```bash
   adb push <frida-server-arm64> /data/local/tmp/frida-server
   adb shell "su -c 'chmod 755 /data/local/tmp/frida-server && /data/local/tmp/frida-server -l 0.0.0.0:27043 &'"
   adb forward tcp:27043 tcp:27043
   ```

2. **Open Mobile Legends on the phone** into Practice Mode or Lobby.

3. **Run the offset extractor**:
   ```powershell
   cd frida
   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l offsets.js --runtime qjs > offsets.log
   ```

4. **Pull / Copy the generated `port.json`**:
   Copy the newly generated `port.json` into `m2/port.json`.

5. **Regenerate config for C++ reader**:
   ```powershell
   cd ../m2
   python port2config.py port.json > m2.cfg
   ```

6. **Kill frida-server** and launch `start.cmd` for live match external reading.
