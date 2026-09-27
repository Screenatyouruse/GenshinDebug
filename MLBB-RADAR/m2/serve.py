#!/usr/bin/env python3
"""m2 serve — stealth orchestration + web server. Frida-free at runtime.

  python serve.py [--hz N | --interval MS] [--port 8080]
"""
import functools
import gzip
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import adb
import cfgkeys
import paths

LATEST = "{}"
LATEST_DRAFT = "{}"
STATE = {"port_json": None, "keys": 0, "loaded_at": 0.0}

def slim_hero_entity(h):
    if not isinstance(h, dict):
        return None
    p = h.get("p") or [0.0, 0.0, 0.0]
    px = round(float(p[0]), 1)
    pz = round(float(p[2] if len(p) > 2 else p[1]), 1)
    return {
        "g": h.get("g"),
        "id": h.get("id"),
        "camp": h.get("camp"),
        "ally": h.get("ally", 0),
        "fog": h.get("fog", 0),
        "p": [px, 0.0, pz],
        "hp": h.get("hp", 0),
        "hm": h.get("hm", 0),
        "hn": h.get("hn", ""),
        "sk": h.get("sk") or [0, 0, 0, 0],
        "sp": h.get("sp", 0)
    }

def slim_jungle_entity(m):
    if not isinstance(m, dict):
        return None
    mid = m.get("id", 0)
    if mid in (2093, 2094, 2084) or m.get("death"):
        return None
    p = m.get("p") or [0.0, 0.0, 0.0]
    px = round(float(p[0]), 1)
    pz = round(float(p[2] if len(p) > 2 else p[1]), 1)
    if abs(px) < 0.01 and abs(pz) < 0.01:
        return None
    return {
        "id": mid,
        "p": [px, 0.0, pz],
        "hp": m.get("hp", 0),
        "hm": m.get("hm", 0)
    }

def slim_replay_data(data):
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
        return data
    slim_frames = []
    for f in data["frames"]:
        if not isinstance(f, dict):
            continue
        sf = {
            "gt": round(float(f.get("gt", 0.0)), 2),
            "self": slim_hero_entity(f.get("self")),
            "heroes": [sh for h in (f.get("heroes") or []) if (sh := slim_hero_entity(h)) is not None],
            "jungle": [sm for m in (f.get("jungle") or []) if (sm := slim_jungle_entity(m)) is not None]
        }
        slim_frames.append(sf)

    return {
        "version": data.get("version", 1),
        "matchId": data.get("matchId", "match"),
        "recordedAt": data.get("recordedAt", ""),
        "selfCamp": data.get("selfCamp", 1),
        "duration": data.get("duration", 0),
        "draft": data.get("draft") or [],
        "frames": slim_frames
    }

if os.path.exists(paths.DRAFT_JSON):
    try:
        with open(paths.DRAFT_JSON, "r", encoding="utf-8") as f:
            LATEST_DRAFT = f.read().strip() or "{}"
    except Exception:
        pass


def load_config():
    if not os.path.exists(paths.PORT_JSON):
        raise RuntimeError(f"port.json not found at {paths.PORT_JSON} - run 'moba refresh' first")
    port = cfgkeys.load(paths.PORT_JSON)
    payload = cfgkeys.emit(port).encode()
    STATE["port_json"] = paths.PORT_JSON
    STATE["keys"] = payload.count(b"\n")
    STATE["loaded_at"] = time.time()
    return payload


def deploy_bin():
    if not os.path.exists(paths.READER_BIN):
        raise RuntimeError(f"reader not built: {paths.READER_BIN} (run 'moba deploy')")
    print(f"[*] deploying {os.path.basename(paths.READER_BIN)} -> {paths.BIN_DEVICE}")
    adb.adb("push", paths.READER_BIN, paths.BIN_DEVICE)
    adb.adb("shell", "su", "-c", f"chmod 755 {paths.BIN_DEVICE}")


LAST_ACCESS_LOG = {}
ACCESS_LOG_PATH = os.path.join(paths.ROOT, "access.log")


def record_access(handler):
    xff = handler.headers.get("X-Forwarded-For", "None")
    client_ip = handler.client_address[0] if handler.client_address else "unknown"
    path = handler.path

    # Deduplicate high-frequency polling on /map.json (log once per minute per IP)
    now = time.time()
    clean_path = path.split("?")[0]
    if clean_path == "/map.json":
        if now - LAST_ACCESS_LOG.get(client_ip, 0) < 60:
            return
        LAST_ACCESS_LOG[client_ip] = now

    ua = handler.headers.get("User-Agent", "-")
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    log_entry = f"[{ts}] IP={client_ip} | XFF={xff} | Path={path} | UA={ua}\n"

    print(f"\n>>> [ACCESS DETECTED] IP: {client_ip} | X-Forwarded-For: {xff} | Path: {path}")

    try:
        with open(ACCESS_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(log_entry)
    except Exception as e:
        print(f"[!] failed to write access log: {e}")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        clean_path = self.path.split("?")[0]
        if clean_path in ("/map.json", "/draft.json", "/health", "/replays"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        elif clean_path == "/" or clean_path.endswith((".html", ".htm", ".js", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp")):
            self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()

    def do_GET(self):
        record_access(self)
        if self.path.startswith("/map.json"):
            body = LATEST.encode()
            self._send(body, "application/json")
        elif self.path.startswith("/draft.json"):
            body = b""
            if LATEST_DRAFT and LATEST_DRAFT != "{}" and LATEST_DRAFT != '{"draft":[]}':
                body = LATEST_DRAFT.encode()
            elif os.path.exists(paths.DRAFT_JSON):
                try:
                    with open(paths.DRAFT_JSON, "rb") as df:
                        body = df.read()
                except Exception:
                    pass
            if not body:
                body = b'{"draft":[]}'
            self._send(body, "application/json")
        elif self.path.startswith("/replays"):
            reps = []
            if os.path.exists(paths.REPLAYS):
                all_files = os.listdir(paths.REPLAYS)
                slim_bases = {f[:-13] for f in all_files if f.endswith(".slim.mreplay")}
                for fname in all_files:
                    if not fname.endswith(".mreplay"):
                        continue
                    is_slim = fname.endswith(".slim.mreplay")
                    base = fname[:-13] if is_slim else fname[:-8]
                    # If raw version exists and slim version already exists, prioritize the slim version
                    if not is_slim and base in slim_bases:
                        continue
                    fpath = os.path.join(paths.REPLAYS, fname)
                    st = os.stat(fpath)
                    info = {"file": fname, "size": st.st_size, "mtime": st.st_mtime, "isSlim": is_slim}
                    try:
                        with open(fpath, "r", encoding="utf-8") as rf:
                            head_chunk = rf.read(1024)
                            for key in ("matchId", "version", "selfCamp", "duration"):
                                if f'"{key}":' in head_chunk:
                                    p1 = head_chunk.find(f'"{key}":') + len(key) + 3
                                    p2 = head_chunk.find(",", p1)
                                    if p2 != -1:
                                        raw_val = head_chunk[p1:p2].strip().strip('"')
                                        info[key] = raw_val
                    except Exception:
                        pass
                    reps.append(info)
                reps.sort(key=lambda x: x["mtime"], reverse=True)
            self._send(json.dumps(reps).encode(), "application/json")
        elif self.path.startswith("/replay.json"):
            query = self.path.split("?", 1)[-1] if "?" in self.path else ""
            params = dict(qc.split("=", 1) for qc in query.split("&") if "=" in qc)
            fname = os.path.basename(params.get("file", ""))
            fpath = os.path.join(paths.REPLAYS, fname)
            raw_mode = params.get("raw", "0") in ("1", "true")

            if fname:
                is_slim = fname.endswith(".slim.mreplay")
                base = fname[:-13] if is_slim else (fname[:-8] if fname.endswith(".mreplay") else fname)
                slim_fname = fname if is_slim else f"{base}.slim.mreplay"
                slim_path = os.path.join(paths.REPLAYS, slim_fname)

                # Fast path: If pre-slimmed replay exists on disk, serve it directly!
                if not raw_mode and os.path.exists(slim_path) and os.path.getsize(slim_path) > 0:
                    try:
                        with open(slim_path, "rb") as rf:
                            body = rf.read()
                        accept_enc = self.headers.get("Accept-Encoding", "")
                        if "gzip" in accept_enc:
                            gz_body = gzip.compress(body, compresslevel=6)
                            self.send_response(200)
                            self.send_header("Content-Type", "application/json")
                            self.send_header("Content-Encoding", "gzip")
                            self.send_header("Content-Length", str(len(gz_body)))
                            self.end_headers()
                            self.wfile.write(gz_body)
                        else:
                            self._send(body, "application/json")
                        return
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                        return
                    except Exception as e:
                        print(f"[!] error reading slim cache {slim_fname}: {e}")

                # Otherwise process source fpath
                if os.path.exists(fpath):
                    try:
                        try:
                            with open(fpath, "r", encoding="utf-8") as rf:
                                data = json.load(rf)
                        except Exception:
                            # Resilient fallback: extract valid frames even if pipe dropped bytes mid-match
                            with open(fpath, "r", encoding="utf-8") as rf:
                                raw_txt = rf.read()
                            valid_frames = []
                            for m in re.finditer(r'\{"t":\s*[\d\.]+,.*?"n":\s*\d+\}', raw_txt):
                                try:
                                    valid_frames.append(json.loads(m.group(0)))
                                except Exception:
                                    pass
                            if not valid_frames:
                                raise
                            data = {
                                "version": 1,
                                "matchId": fname.replace(".mreplay", ""),
                                "recordedAt": "",
                                "selfCamp": valid_frames[0].get("self", {}).get("camp", 1),
                                "duration": round(valid_frames[-1].get("gt", 0.0) - valid_frames[0].get("gt", 0.0), 1),
                                "frames": valid_frames
                            }
                            try:
                                with open(fpath, "w", encoding="utf-8") as rf:
                                    json.dump(data, rf)
                            except Exception:
                                pass

                        if not raw_mode:
                            data = slim_replay_data(data)

                        body = json.dumps(data, separators=(",", ":")).encode("utf-8")

                        # Cache slimmed replay locally so future requests load in milliseconds!
                        if not raw_mode:
                            try:
                                with open(slim_path, "wb") as wf:
                                    wf.write(body)
                                print(f"[*] saved slim replay locally: {slim_fname} ({len(body) / 1024 / 1024:.2f} MB)")
                            except Exception as e:
                                print(f"[!] failed to write slim replay cache: {e}")

                        accept_enc = self.headers.get("Accept-Encoding", "")
                        if "gzip" in accept_enc:
                            gz_body = gzip.compress(body, compresslevel=6)
                            try:
                                self.send_response(200)
                                self.send_header("Content-Type", "application/json")
                                self.send_header("Content-Encoding", "gzip")
                                self.send_header("Content-Length", str(len(gz_body)))
                                self.end_headers()
                                self.wfile.write(gz_body)
                            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                                pass
                        else:
                            self._send(body, "application/json")
                    except Exception as e:
                        self.send_error(500, str(e))
                else:
                    self.send_error(404, "Replay not found")
            else:
                self.send_error(400, "Missing file parameter")
        elif self.path.startswith("/health"):
            body = json.dumps({
                "ok": bool(STATE["loaded_at"]),
                "port_json": STATE["port_json"],
                "keys": STATE["keys"],
                "age_s": round(time.time() - STATE["loaded_at"], 1) if STATE["loaded_at"] else None,
            }).encode()
            self._send(body, "application/json")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/save_replay"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length).decode("utf-8")
                data = json.loads(payload)
                match_id = data.get("matchId") or ("match_" + time.strftime("%Y%m%d_%H%M%S"))
                safe_name = "".join(c for c in match_id if c.isalnum() or c in ("_", "-")) + ".mreplay"
                fpath = os.path.join(paths.REPLAYS, safe_name)
                with open(fpath, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                print(f"[*] saved replay from web: {safe_name} ({len(data.get('frames', []))} frames)")
                resp = json.dumps({"ok": True, "file": safe_name}).encode()
                self._send(resp, "application/json")
            except Exception as e:
                err = json.dumps({"ok": False, "error": str(e)}).encode()
                self._send(err, "application/json")
        else:
            self.send_error(404)

    def _send(self, body, ctype):
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def log_message(self, *a):
        pass


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def serve_http(port):
    handler = functools.partial(Handler, directory=paths.WWW_DIR)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"[*] overlay http://127.0.0.1:{port}  ( LAN: http://{lan_ip()}:{port} )")
    print(f"[*]   /map.json  /health  www={paths.WWW_DIR}")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def stream_session(pid, interval_ms, cfg_payload, enable_record=True, enable_draft_disk=True, enable_summon=True):
    global LATEST, LATEST_DRAFT
    proc = subprocess.Popen(
        adb.cmd("shell", "su", "-c", f"exec {paths.BIN_DEVICE} {pid} {interval_ms}"),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    proc.stdin.write(cfg_payload)
    proc.stdin.flush()
    proc.stdin.close()
    print(f"[*] streaming pid {pid} @ {interval_ms}ms via {adb.SERIAL or 'usb'}")
    seen_summons = {}
    summon_log_path = os.path.join(paths.LOGS, "summon_skills.log")
    frame_idx = 0

    current_recording = None
    last_record_t = 0.0

    def finish_recording(rec):
        if not rec or len(rec.get("frames", [])) < 60:
            return
        frames = rec["frames"]
        first_gt = frames[0].get("gt", 0.0)
        last_gt = frames[-1].get("gt", 0.0)
        rec["duration"] = round(max(0.0, last_gt - first_gt), 1)
        safe_name = f"{rec['matchId']}.mreplay"
        fpath = os.path.join(paths.REPLAYS, safe_name)
        try:
            with open(fpath, "w", encoding="utf-8") as rf:
                json.dump(rec, rf)
            print(f"[*] auto-recorded match saved: {safe_name} ({len(frames)} frames, {rec['duration']}s)")
        except Exception as err:
            print(f"[!] error auto-saving replay: {err}")

    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode(errors="replace").strip()
        if line.startswith("{"):
            LATEST = line
            frame_idx += 1

            # 1. Draft persistence: update draft in memory and optionally sync to disk
            if '"draft":' in line:
                try:
                    fobj = json.loads(line)
                    dr = fobj.get("draft", [])
                    if isinstance(dr, list):
                        if len(dr) > 0:
                            clean_draft = json.dumps({"draft": dr})
                            if clean_draft != LATEST_DRAFT:
                                LATEST_DRAFT = clean_draft
                                if enable_draft_disk:
                                    with open(paths.DRAFT_JSON, "w", encoding="utf-8") as df:
                                        df.write(clean_draft)
                        elif dr == [] and LATEST_DRAFT != '{"draft":[]}' and ('"bm":0' in line or '"bm": 0' in line):
                            # Engine signaled draft reset (lobby / post-match)
                            LATEST_DRAFT = '{"draft":[]}'
                            if enable_draft_disk:
                                try:
                                    with open(paths.DRAFT_JSON, "w", encoding="utf-8") as df:
                                        df.write('{"draft":[]}')
                                except Exception:
                                    pass
                except Exception as e:
                    print(f"[!] error handling draft: {e}")

            # 2. Auto-recording in-battle frames (~6.6 Hz / 150ms)
            if enable_record:
                is_bm = ('"bm":1' in line or '"bm": 1' in line)
                if is_bm:
                    now = time.time()
                    if now - last_record_t >= 0.15:
                        last_record_t = now
                        try:
                            fobj = json.loads(line)
                            if current_recording is None:
                                ts_str = time.strftime("%Y%m%d_%H%M%S")
                                hero_name = fobj.get("self", {}).get("hn") or "Match"
                                current_recording = {
                                    "version": 1,
                                    "matchId": f"{ts_str}_{hero_name}",
                                    "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                    "selfCamp": fobj.get("self", {}).get("camp", 1),
                                    "duration": 0,
                                    "frames": []
                                }
                                if LATEST_DRAFT and '"draft":' in LATEST_DRAFT:
                                    try:
                                        current_recording["draft"] = json.loads(LATEST_DRAFT).get("draft", [])
                                    except Exception:
                                        pass
                                print(f"[*] auto-recording match started: {current_recording['matchId']}")

                            current_recording["frames"].append(fobj)
                        except Exception:
                            pass
                elif current_recording is not None and ('"bm":0' in line or '"bm": 0' in line):
                    finish_recording(current_recording)
                    current_recording = None
                    LATEST_DRAFT = '{"draft":[]}'
                    if enable_draft_disk:
                        try:
                            with open(paths.DRAFT_JSON, "w", encoding="utf-8") as df:
                                df.write('{"draft":[]}')
                        except Exception:
                            pass

            # 3. Summon skills logger
            if enable_summon and '"sm":' in line and (frame_idx % 10 == 0):
                try:
                    data = json.loads(line)
                    for h in data.get("heroes", []):
                        gid = h.get("g")
                        sm = h.get("sm")
                        if gid and sm is not None and sm != -1:
                            if seen_summons.get(gid) != sm:
                                seen_summons[gid] = sm
                                hn = h.get("hn") or f"Hero #{h.get('id')}"
                                camp = h.get("camp", 0)
                                ally = "ALLY" if h.get("ally") else "ENEMY"
                                ts = time.strftime("%H:%M:%S")
                                log_line = f"[{ts}] [SUMMON] {ally} '{hn}' (guid={gid}, camp={camp}) -> summonSkillId={sm} (0x{sm:X})"
                                print(log_line)
                                with open(summon_log_path, "a", encoding="utf-8") as lf:
                                    lf.write(log_line + "\n")
                except Exception:
                    pass
        elif line:
            print("[reader]", line)

    proc.wait()
    if enable_record and current_recording is not None:
        finish_recording(current_recording)
        current_recording = None
    LATEST_DRAFT = '{"draft":[]}'
    if enable_draft_disk:
        try:
            with open(paths.DRAFT_JSON, "w", encoding="utf-8") as df:
                df.write('{"draft":[]}')
        except Exception:
            pass
    print(f"[*] session pid {pid} ended (retaining last state)")


def main():
    interval = "16"
    port = 8080
    serial = None
    want_wifi = False
    enable_record = True
    enable_draft_disk = True
    enable_summon = True

    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--hz" and i + 1 < len(argv):
            interval = str(int(round(1000 / float(argv[i + 1]))))
        elif a == "--interval" and i + 1 < len(argv):
            interval = argv[i + 1]
        elif a == "--port" and i + 1 < len(argv):
            port = int(argv[i + 1])
        elif a == "--serial" and i + 1 < len(argv):
            serial = argv[i + 1]
        elif a == "--wifi":
            want_wifi = True
        elif a == "--no-record":
            enable_record = False
        elif a == "--no-draft-disk":
            enable_draft_disk = False
        elif a == "--no-summon":
            enable_summon = False

    paths.ensure_dirs()
    adb.pick(prefer="wifi" if want_wifi else None, serial=serial)
    if want_wifi:
        s = adb.ensure_online(prefer="wifi")
        if s:
            print(f"[*] wireless device: {s}")
        else:
            print("[!] no wireless device - run 'moba wireless connect' (or pair) first")
    elif not adb.SERIAL:
        print("[!] multiple devices? pin one with --serial <ip:port> (or use --wifi)")
    print(f"[*] active serial: {adb.SERIAL or '(auto)'}")
    print(f"[*] features: record={'ON' if enable_record else 'OFF'} | draft_disk={'ON' if enable_draft_disk else 'OFF'} | summon={'ON' if enable_summon else 'OFF'}")

    deploy_bin()
    payload = load_config()
    print(f"[*] config: {STATE['port_json']} ({STATE['keys']} keys)")
    _port = cfgkeys.load(paths.PORT_JSON)
    print(f"[*] build:  {cfgkeys.build_id(_port)}")
    for _w in cfgkeys.health(_port):
        print("[!] " + _w)

    serve_http(port)
    while True:
        # reconnect a dropped Wi-Fi transport before every session attempt
        adb.ensure(prefer="wifi" if want_wifi else None)
        if want_wifi and adb.SERIAL not in adb.online():
            if adb.ensure_online(prefer="wifi"):
                print(f"[*] reconnected: {adb.SERIAL}")
            else:
                print("[*] wireless device offline - waiting for reconnection...")
                time.sleep(5)
                continue
        pid, pkg = adb.newest_child()
        if not pid:
            print("[*] waiting for game engine child (:UnityKillsMe)...")
            time.sleep(3)
            continue
        payload = load_config()          # reload so a refresh mid-run takes effect
        print(f"[*] engine pid {pid} pkg {pkg} | cfg {STATE['keys']} keys")
        stream_session(pid, interval, payload, enable_record, enable_draft_disk, enable_summon)
        time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
