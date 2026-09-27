"""m2 — canonical paths and device constants. Everything imports from here.

Single source of truth. No other module may hardcode a path or device location.
"""
import os
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(ROOT)                       # .../moba
PROJECT = os.path.dirname(PARENT)                    # .../a35project

# ---- laptop artifacts (owned by THIS folder) ----
PORT_JSON = os.environ.get("M2_PORT_JSON", os.path.join(ROOT, "port.json"))
READER_SRC = os.path.join(ROOT, "cppport.cpp")
READER_BIN = os.path.join(ROOT, ".audio_mixer")      # build output == deploy artifact
WWW_DIR = os.environ.get("M2_WWW", os.path.join(PARENT, "www"))
BRIDGE = os.path.join(PROJECT, "mlbb-bridge")
BRIDGE_DIST = os.path.join(BRIDGE, "dist")
BRIDGE_AGENT = os.path.join(BRIDGE, "agent")
BUILD_SH = os.path.join(ROOT, "build.sh")
LOGS = os.path.join(ROOT, "logs")
REPLAYS = os.path.join(ROOT, "replays")
DRAFT_JSON = os.path.join(WWW_DIR, "draft.json")
WIRELESS_JSON = os.path.join(ROOT, "wireless.json")   # last good wireless serial

# ---- device ----
DEVICE_TMP = "/data/local/tmp"
BIN_DEVICE = DEVICE_TMP + "/.audio_mixer"
CFG_DEVICE = DEVICE_TMP + "/m2.cfg"
PKG_HINT = "mobile.legends"

# ---- frida (only used by the pre-game offset refresh) ----
FRIDA = os.environ.get(
    "M2_FRIDA",
    r"C:\Users\berni\AppData\Local\Python\pythoncore-3.14-64\Scripts\frida.exe",
)
FRIDA_PS = os.path.join(os.path.dirname(FRIDA), "frida-ps.exe")
FRIDA_PORT = "127.0.0.1:27043"


def ensure_dirs():
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(REPLAYS, exist_ok=True)


def frida_alive() -> bool:
    try:
        r = subprocess.run([FRIDA_PS, "-H", FRIDA_PORT], capture_output=True, timeout=30)
        return r.returncode == 0
    except Exception:
        return False
