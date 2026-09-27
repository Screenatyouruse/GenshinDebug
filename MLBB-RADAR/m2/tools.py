#!/usr/bin/env python3
"""m2 tools — the whole workflow in one place.

usage: python tools.py <cmd> [args]

  status              device / engine child / frida / port.json health
  selftest            validate port.json keys + run reader once + check frame shape
  once [ms] [secs]    bounded reader snapshot (build cfg in memory, print frames)
  debug [ms] [secs]   SPELLDBG one-shot: per-RoomData scan + mirror diagnostics (stderr)
  deploy [--no-build] build (WSL), push to device, restart reader
  build               build only (WSL)
  check               fast syntax check (WSL g++)
  refresh             frida: resolve offsets -> port.json (pre-game only)
  attach <agent>      attach mlbb-bridge agent (name without .js)
  devsh <script.sh>   push + run a local script as root on the device
  frida               (re)start frida-server + adb forward
  wireless <sub>      pair/connect/status over Wi-Fi (no cable)
                      sub: status | pair <ip:port> <code> [ip:debugport]
                           | connect [ip:port] | auto | tcpip [port] | off

global: --serial <ip:port|hw-serial>  pin the device for any device command
"""
import json
import os
import subprocess
import sys
import threading
import time

import adb
import cfgkeys
import paths

ROOT = paths.ROOT


def _wsl(p: str) -> str:
    p = os.path.abspath(p)
    return "/mnt/" + p[0].lower() + p[2:].replace("\\", "/")


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- build
def do_build(check_only=False):
    if not os.path.exists(paths.BUILD_SH):
        print(f"missing {paths.BUILD_SH}"); return False
    flag = " --check" if check_only else ""
    r = _run(["wsl", "-e", "bash", "-lc", f"bash {_wsl(paths.BUILD_SH)}{flag}"])
    print((r.stdout or "").strip())
    if r.returncode != 0 or "BUILD FAILED" in (r.stdout or ""):
        print((r.stderr or "").strip())
        return False
    return True


def cmd_build():
    do_build(False)


def cmd_check():
    do_build(True)


# ---------------------------------------------------------------- deploy
def cmd_deploy(args):
    if "--no-build" not in args:
        if not do_build(False):
            print("build failed - aborting deploy"); return
    if not os.path.exists(paths.READER_BIN):
        print(f"reader missing: {paths.READER_BIN}"); return
    adb.adb("push", paths.READER_BIN, paths.BIN_DEVICE)
    adb.adb("shell", "su", "-c", f"chmod 755 {paths.BIN_DEVICE}")
    adb.adb("shell", "su", "-c", f"pkill -f {os.path.basename(paths.BIN_DEVICE)}")
    print(f"[*] deployed -> {paths.BIN_DEVICE} (running serve will respawn it)")


# ---------------------------------------------------------------- status
def cmd_status():
    print("== adb ==")
    print(adb.adb_out("devices"))
    kids = adb.engine_children()
    print(f"== engine children: {kids if kids else 'NONE (game closed?)'} ==")
    pid, pkg = adb.newest_child()
    if pid:
        print(f"   active: pid={pid} pkg={pkg}")
    print(f"== frida-server == alive: {paths.frida_alive()}")
    print("== device ==")
    print(adb.adb_out("shell", "su", "-c", f"ls -la {paths.BIN_DEVICE} 2>/dev/null"))
    if os.path.exists(paths.PORT_JSON):
        age = time.time() - os.path.getmtime(paths.PORT_JSON)
        port = cfgkeys.load(paths.PORT_JSON)
        n = len(cfgkeys.emit(port).splitlines())
        print(f"== port.json: {paths.PORT_JSON} ({age:.0f}s old, {n} keys) ==")
        print(f"   build: {cfgkeys.build_id(port)}")
        if age > 24 * 3600:
            print("   [warn] older than 24h - refresh if the game updated")
        for w in cfgkeys.health(port):
            print("   [warn] " + w)
    else:
        print(f"== port.json MISSING: {paths.PORT_JSON} (run 'moba refresh') ==")


# ---------------------------------------------------------------- selftest
def cmd_selftest():
    ok = True
    if not os.path.exists(paths.PORT_JSON):
        print(f"FAIL port.json missing: {paths.PORT_JSON}"); return 1
    port = cfgkeys.load(paths.PORT_JSON)
    cfg = cfgkeys.emit(port)
    keys = {line.split("=", 1)[0] for line in cfg.splitlines() if "=" in line}
    for k in cfgkeys.REQUIRED:
        if k not in keys:
            print(f"FAIL missing required key: {k}"); ok = False
    for k in cfgkeys.RECOMMENDED:
        if k not in keys:
            print(f"WARN missing recommended key: {k} (draft/room features degraded)")

    pid, _ = adb.newest_child()
    if not pid:
        print("WARN no engine child - skipping live frame check")
        print("PASS (static)" if ok else "FAIL"); return 0 if ok else 1

    # first bm:0 frame includes a cold heap scan; give it room
    frame = _reader_once(cfg.encode(), pid, ms=250, secs=4.0)[-1:] or []
    if not frame:
        print("FAIL reader produced no frames"); return 1
    try:
        d = json.loads(frame[0])
    except Exception as e:
        print(f"FAIL frame not JSON: {e}: {frame[0][:120]}"); return 1
    for k in ("t", "bm"):
        if k not in d:
            print(f"FAIL frame missing '{k}'"); ok = False
    if d.get("bm") == 0 and "draft" not in d and "room" not in d:
        print("WARN bm:0 frame has neither draft nor room (not in draft/lobby?)")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


# ---------------------------------------------------------------- reader snapshot
def _reader_once(cfg: bytes, pid: int, ms=400, secs=2.0, dbg=False):
    env = "SPELLDBG=1 " if dbg else ""
    proc = subprocess.Popen(
        adb.ADB + ["shell", "su", "-c", f"{env}exec {paths.BIN_DEVICE} {pid} {ms}"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc.stdin.write(cfg); proc.stdin.flush(); proc.stdin.close()
    frames, errs = [], []

    def rd(stream, to_frames):
        for raw in iter(stream.readline, b""):
            line = raw.decode(errors="replace").strip()
            if not line:
                continue
            if to_frames and line.startswith("{"):
                frames.append(line)
            else:
                errs.append(line)

    threading.Thread(target=rd, args=(proc.stdout, True), daemon=True).start()
    threading.Thread(target=rd, args=(proc.stderr, False), daemon=True).start()
    deadline = time.time() + secs
    while time.time() < deadline and proc.poll() is None:
        time.sleep(0.05)
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()
    if dbg:
        for e in errs:
            print("[dbg]", e)
    else:
        for e in errs[:10]:
            print("[reader]", e)
    return frames


def _save_draft_from_frames(frames):
    for line in reversed(frames):
        if '"draft":' in line and '"draft":[]' not in line:
            try:
                data = json.loads(line)
                draft = data.get("draft", [])
                if isinstance(draft, list) and len(draft) > 0:
                    clean = json.dumps({"draft": draft})
                    with open(paths.DRAFT_JSON, "w", encoding="utf-8") as f:
                        f.write(clean)
                    print(f"[*] saved {len(draft)} draft players to {paths.DRAFT_JSON}")
                    break
            except Exception:
                pass


def cmd_once(args):
    ms = int(args[0]) if args else 400
    secs = float(args[1]) if len(args) > 1 else 2.0
    pid, _ = adb.newest_child()
    if not pid:
        print("no engine child"); return
    cfg = cfgkeys.emit(cfgkeys.load(paths.PORT_JSON)).encode()
    frames = _reader_once(cfg, pid, ms, secs)
    _save_draft_from_frames(frames)
    for line in frames[-4:]:
        try:
            print(json.dumps(json.loads(line), indent=1)[:2500])
        except Exception:
            print(line)


def cmd_debug(args):
    """SPELLDBG one-shot: stderr shows every RoomData candidate + mirror classification."""
    ms = int(args[0]) if args else 400
    secs = float(args[1]) if len(args) > 1 else 3.0
    pid, _ = adb.newest_child()
    if not pid:
        print("no engine child"); return
    cfg = cfgkeys.emit(cfgkeys.load(paths.PORT_JSON)).encode()
    frames = _reader_once(cfg, pid, ms, secs, dbg=True)
    _save_draft_from_frames(frames)
    for line in frames[-1:]:
        try:
            print(json.dumps(json.loads(line), indent=1)[:2000])
        except Exception:
            print(line)


def _extract_json(text):
    """First balanced JSON object that starts at the beginning of a line."""
    i = text.find("\n{")
    while i != -1:
        start = i + 1
        depth, in_str, esc = 0, False, False
        for j in range(start, len(text)):
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:j + 1])
                    except Exception:
                        break
        i = text.find("\n{", i + 1)
    return None


# ---------------------------------------------------------------- refresh (frida, pre-game)
def cmd_refresh():
    pid, pkg = adb.newest_child()
    if not pid:
        print("no engine child - launch MLBB first"); return
    if not paths.frida_alive():
        print("[*] frida-server down - starting it")
        cmd_frida()
        if not paths.frida_alive():
            print("frida-server still down - abort"); return

    script = os.path.join(paths.BRIDGE_DIST, "offsets.js")
    if not os.path.exists(script):
        print(f"agent not built: {script} (run build-agents)"); return
    paths.ensure_dirs()
    log = os.path.join(paths.LOGS, "offsets.log")
    print(f"[*] resolving offsets (pid={pid}) ...")
    with open(log, "w") as out:
        p = subprocess.Popen([paths.FRIDA, "-H", paths.FRIDA_PORT, "-p", str(pid),
                              "-l", script, "--runtime", "qjs", "-q"], stdout=out, stderr=out)
        time.sleep(50)
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()
    txt = open(log, errors="replace").read()
    for line in txt.splitlines():
        if "port.json ->" in line:
            print("[*] " + line.strip())

    # preferred: the agent prints the full JSON to stdout. Path-independent, and
    # can't pick up a stale copy from another install/user dir (the old bug).
    port = _extract_json(txt)
    if port is not None:
        with open(paths.PORT_JSON, "w", encoding="utf-8") as f:
            json.dump(port, f, indent=1)
        print("[*] port.json written from agent stdout")
    else:
        print("[!] could not parse agent stdout - falling back to device pull")
        pull = os.path.join(ROOT, "pull_port.sh")
        adb.run_as_root(pull)
        r = adb.adb("pull", f"{paths.DEVICE_TMP}/m2_port.json", paths.PORT_JSON)
        if r.returncode != 0:
            print("pull failed - offsets agent may not have written port.json"); return
        adb.adb("shell", "su", "-c", f"rm -f {paths.DEVICE_TMP}/m2_port.json")

    port = cfgkeys.load(paths.PORT_JSON)
    print(f"[*] port.json -> {paths.PORT_JSON} "
          f"({len(cfgkeys.emit(port).splitlines())} keys, build {cfgkeys.build_id(port)})")
    for w in cfgkeys.health(port):
        print("[!] " + w)


# ---------------------------------------------------------------- agents / misc
def cmd_attach(agent):
    pid, _ = adb.newest_child()
    if not pid:
        print("no engine child"); return
    script = os.path.join(paths.BRIDGE_DIST, f"{agent}.js")
    if not os.path.exists(script):
        print(f"agent not compiled: {script}"); return
    print(f"[*] attaching {agent} to pid={pid} (q to detach)")
    subprocess.run([paths.FRIDA, "-H", paths.FRIDA_PORT, "-p", str(pid), "-l", script, "-q"])


def cmd_devsh(args):
    if not args:
        print("usage: devsh <script.sh> [args...]"); return
    local = args[0]
    if not os.path.exists(local):
        print(f"missing {local}"); return
    r = adb.run_as_root(local, *args[1:])
    sys.stdout.write(r.stdout.decode(errors="replace"))
    sys.stderr.write(r.stderr.decode(errors="replace"))


def cmd_frida():
    print("[*] (re)starting frida-server ...")
    adb.adb_out("shell", "su -c 'nohup /data/local/tmp/logd-helper -l 127.0.0.1:27043 >/dev/null 2>&1 &'")
    time.sleep(2)
    adb.adb("forward", "tcp:27043", "tcp:27043")
    print("[*] alive:", paths.frida_alive())


# ---------------------------------------------------------------- wireless
def cmd_wireless(args):
    sub = (args[0] if args else "status").lower()
    rest = args[1:]

    if sub in ("status", "st"):
        print("== adb devices ==")
        print(adb._raw_out("devices", "-l"))
        print(f"== active serial: {adb.SERIAL or '(auto)'}")
        print(f"== saved wireless: {adb.load_target() or '(none)'}")
        print(f"== online: {adb.online()}")
        svc = adb.mdns_services()
        if svc:
            print("== mdns ==")
            print(svc)
        if not adb.is_tcp(adb.SERIAL):
            print("   [wifi] not on a wireless transport - run: moba wireless connect")
        return

    if sub == "pair":
        if len(rest) < 2:
            print("usage: moba wireless pair <ip:pairport> <code> [ip:debugport]"); return
        addr, code = rest[0], rest[1]
        if ":" not in addr and ":" in code:
            addr, code = code, addr
            print("[*] (args look reversed - using address first, then code)")
        if ":" not in addr:
            print(f"[!] '{addr}' is not ip:port. usage: moba wireless pair <ip:pairport> <code>")
            return
        ok, msg = adb.pair(addr, code)
        print(("[*] " if ok else "[!] ") + msg)
        if not ok:
            return
        target = rest[2] if len(rest) > 2 else adb.discover("connect")
        if target:
            ok, msg = adb.connect(target)
            print(("[*] " if ok else "[!] ") + msg)
        else:
            print("[*] paired. enable Wireless debugging, then: moba wireless connect <ip:port>")
        return

    if sub in ("connect", "on"):
        ok, msg = adb.connect(rest[0] if rest else None)
        print(("[*] " if ok else "[!] ") + msg)
        if ok:
            print(f"[*] active serial: {adb.SERIAL}")
        return

    if sub in ("auto", "reconnect"):
        print(f"[*] active serial: {adb.ensure_online(prefer='wifi') or 'NONE'}")
        return

    if sub == "tcpip":
        port = rest[0] if rest else "5555"
        ok, msg = adb.tcpip(port)
        print(("[*] " if ok else "[!] ") + msg)
        if ok:
            ip = adb.device_ip()
            if ip:
                ok2, msg2 = adb.connect(f"{ip}:{port}")
                print(("[*] " if ok2 else "[!] ") + msg2)
            else:
                print(f"[*] run: moba wireless connect <device-ip>:{port}")
        return

    if sub in ("off", "disconnect"):
        ok, msg = adb.disconnect(rest[0] if rest else None)
        adb.clear_target()
        print(("[*] " if ok else "[!] ") + msg)
        return

    print("usage: moba wireless [status|pair <ip:port> <code>|connect [ip:port]|auto|tcpip [port]|off]")


CMDS = {
    "status": lambda a: cmd_status(),
    "selftest": lambda a: sys.exit(cmd_selftest()),
    "once": cmd_once,
    "debug": cmd_debug,
    "deploy": cmd_deploy,
    "build": lambda a: cmd_build(),
    "check": lambda a: cmd_check(),
    "refresh": lambda a: cmd_refresh(),
    "attach": lambda a: cmd_attach(a[0]) if a else print("usage: attach <agent>"),
    "devsh": cmd_devsh,
    "frida": lambda a: cmd_frida(),
    "wireless": cmd_wireless,
}

# commands that talk to the device; auto-pick when more than one is attached
DEVICE_CMDS = {"status", "selftest", "once", "debug", "deploy", "refresh", "attach", "devsh", "frida"}


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] not in CMDS:
        print(__doc__)
        sys.exit(1)
    cmd_name, rest = argv[0], argv[1:]
    if "--serial" in rest:
        i = rest.index("--serial")
        if i + 1 < len(rest):
            adb.set_serial(rest[i + 1])
            del rest[i:i + 2]
    if cmd_name in DEVICE_CMDS:
        adb.ensure()
    CMDS[cmd_name](rest)


if __name__ == "__main__":
    main()
