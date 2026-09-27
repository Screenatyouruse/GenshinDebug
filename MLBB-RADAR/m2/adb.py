"""m2 — adb helpers + engine-child discovery. One place, no inline su chains.

The single place that knows how to talk to a device over *either* transport.
USB and Wi-Fi (TCP) are selected through a module-level serial; set it with
`set_serial` / `pick` / `ensure`, and every helper here — and the reader
stream in serve.py — follows automatically. Callers that build their own
argv should use `cmd()` instead of `ADB`.
"""
import json
import subprocess
import time

import paths

ADB = ["adb"]
SERIAL = None


# ---------------------------------------------------------------- transport
def _raw(*args):
    """adb without a forced serial (used for discovery/pairing)."""
    return subprocess.run(ADB + list(args), capture_output=True)


def _raw_out(*args) -> str:
    return _raw(*args).stdout.decode(errors="replace").strip()


def set_serial(s):
    global SERIAL
    SERIAL = s or None
    return SERIAL


def cmd(*args):
    """Full argv targeting the active serial (for Popen / subprocess)."""
    return ADB + (["-s", SERIAL] if SERIAL else []) + list(args)


def is_tcp(s=None) -> bool:
    """TCP serials are `host:port`; USB serials are the device's hw serial."""
    s = s or SERIAL
    return bool(s) and ":" in s


# ---------------------------------------------------------------- discovery
def devices():
    """[(serial, state)] from `adb devices -l`, online and offline."""
    rows = []
    for line in _raw_out("devices", "-l").splitlines():
        line = line.strip()
        if not line or line.startswith("List of"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1] in ("device", "offline", "unauthorized"):
            rows.append((parts[0], parts[1]))
    return rows


def online():
    return [s for s, st in devices() if st == "device"]


def mdns_services():
    return _raw_out("mdns", "services")


def discover_all(kind="connect"):
    """All `ip:port` candidates from `adb mdns services` for kind (connect|pairing)."""
    want = {
        "connect": "_adb-tls-connect._tcp",
        "pairing": "_adb-tls-pairing._tcp",
    }.get(kind, kind)
    found = []
    for line in mdns_services().splitlines():
        if want not in line:
            continue
        for tok in line.replace("\t", " ").split():
            if ":" in tok and tok[0].isdigit() and tok not in found:
                found.append(tok)
    return found


def discover(kind="connect"):
    """Best-effort first `ip:port` from `adb mdns services`."""
    c = discover_all(kind)
    return c[0] if c else None


# ---------------------------------------------------------------- saved target
def load_target():
    try:
        with open(paths.WIRELESS_JSON) as f:
            return json.load(f).get("target") or None
    except Exception:
        return None


def save_target(t):
    if not t:
        return
    try:
        with open(paths.WIRELESS_JSON, "w") as f:
            json.dump({"target": t}, f)
    except Exception:
        pass


def clear_target():
    try:
        import os
        os.remove(paths.WIRELESS_JSON)
    except Exception:
        pass


# ---------------------------------------------------------------- selection
def pick(prefer=None, serial=None):
    """Choose the active serial.

    prefer: 'wifi' | 'usb' | None. Prefers an explicit serial, then the saved
    wireless target, then `prefer`, then the only device. Never guesses between
    two equally-valid transports.
    """
    global SERIAL
    if serial:
        return set_serial(serial)
    devs = online()
    if not devs:
        return set_serial(None)
    if SERIAL in devs:
        return SERIAL
    wifi = [s for s in devs if is_tcp(s)]
    usb = [s for s in devs if not is_tcp(s)]
    saved = load_target()
    if saved in wifi and (prefer in ("wifi", None)):
        return set_serial(saved)
    if prefer == "wifi" and wifi:
        return set_serial(wifi[0])
    if prefer == "usb" and usb:
        return set_serial(usb[0])
    if len(devs) == 1:
        return set_serial(devs[0])
    if saved in devs:
        return set_serial(saved)
    return set_serial(None)   # ambiguous: let adb report it


def ensure(prefer=None):
    if SERIAL in online():
        return SERIAL
    return pick(prefer)


# ---------------------------------------------------------------- wireless
def connect(addr=None):
    """`adb connect`; falls back to mDNS discovery (tries every advertised port).

    Returns (ok, message).
    """
    candidates = [addr] if addr else discover_all("connect")
    if not candidates:
        return False, "no address (pass ip:port, or enable Wireless debugging for mDNS)"
    last = ""
    for cand in candidates:
        r = _raw("connect", cand)
        last = (r.stdout + r.stderr).decode(errors="replace").strip()
        if "connected" in last.lower():
            save_target(cand)
            set_serial(cand)
            return True, last
    return False, last or "connect failed"


def pair(addr, code):
    """`adb pair addr code`. Returns (ok, message)."""
    r = _raw("pair", addr, code)
    return r.returncode == 0, (r.stdout + r.stderr).decode(errors="replace").strip()


def disconnect(addr=None):
    addr = addr or SERIAL or load_target()
    if not addr:
        return False, "nothing to disconnect"
    r = _raw("disconnect", addr)
    if addr == SERIAL:
        set_serial(None)
    return r.returncode == 0, (r.stdout + r.stderr).decode(errors="replace").strip()


def tcpip(port=5555):
    """Switch the (USB-attached) device to legacy TCP mode."""
    r = _raw("tcpip", str(port))
    return r.returncode == 0, (r.stdout + r.stderr).decode(errors="replace").strip()


def device_ip():
    """Device's own WLAN IP, for the legacy tcpip path."""
    try:
        out = _raw_out("shell", "ip route")
        for line in out.splitlines():
            if "src" in line:
                return line.split()[line.split().index("src") + 1]
    except Exception:
        pass
    return None


def wait_online(serial=None, tries=10, delay=1.0):
    serial = serial or SERIAL
    for _ in range(tries):
        if not serial or serial in online():
            return True
        time.sleep(delay)
    return False


def ensure_online(prefer=None, tries=5, delay=1.5):
    """Reconnect a dropped wireless device. Returns serial or None."""
    if SERIAL in online():
        return SERIAL
    for i in range(tries):
        pick(prefer)
        if SERIAL in online():
            return SERIAL
        target = load_target()
        if target:
            connect(target)
        if SERIAL in online():
            return SERIAL
        if i < tries - 1:
            time.sleep(delay)
    return SERIAL if SERIAL in online() else None


# ---------------------------------------------------------------- serial commands
def adb(*args):
    return subprocess.run(cmd(*args), capture_output=True)


def adb_out(*args) -> str:
    return subprocess.run(cmd(*args), capture_output=True).stdout.decode(errors="replace").strip()


def engine_children():
    """[(pid, fullname)] for MLBB engine/child processes."""
    out = adb_out("shell", "ps -A -o PID,NAME")
    rows = []
    
    # Target identifiers: the child tag, package hint, or display name
    targets = (":UnityKillsMe", paths.PKG_HINT, "Mobile Legends")

    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue

        # Split into at most 2 parts: [PID, FULL_NAME]
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue

        pid, name = int(parts[0]), parts[1]

        # Match any known signature
        if any(t in name for t in targets):
            rows.append((pid, name))
            print(rows)

    return rows


def newest_child():
    """Engine child, preferring the plain package over a regional variant (.usa)."""
    best, best_score = (None, None), None
    for pid, name in engine_children():
        try:
            st = int(adb_out("shell", f"cat /proc/{pid}/stat 2>/dev/null").split()[21])
        except (ValueError, IndexError):
            st = 0
        pkg = name.split(":")[0]
        score = (1 if pkg == "com.mobile.legends" else 0, st)
        if best_score is None or score >= best_score:
            best, best_score = (pid, pkg), score
    return best


def run_as_root(script: str, *args):
    """Push a local .sh to DEVICE_TMP and run it as root. Honors the no-inline-su rule."""
    remote = f"{paths.DEVICE_TMP}/m2run.sh"
    adb("push", script, remote)
    q = " ".join(f"'{a}'" for a in args)
    return adb("shell", "su", "-c", f"sh {remote} {q}".strip())


def forward_remove():
    adb("forward", "--remove", "tcp:27043")
