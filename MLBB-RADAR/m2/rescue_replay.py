import sys
import os
import re
import json

def rescue_file(fpath):
    if not os.path.exists(fpath):
        print(f"File not found: {fpath}")
        return False

    print(f"Reading {fpath} ({os.path.getsize(fpath)} bytes)...")
    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    # Extract metadata if available
    match_id = os.path.splitext(os.path.basename(fpath))[0]
    m_id = re.search(r'"matchId":\s*"([^"]+)"', text[:3000])
    if m_id:
        match_id = m_id.group(1)

    rec_at = "2026-09-26T12:36:42Z"
    m_rec = re.search(r'"recordedAt":\s*"([^"]+)"', text[:3000])
    if m_rec:
        rec_at = m_rec.group(1)

    self_camp = 2
    m_camp = re.search(r'"selfCamp":\s*(\d+)', text[:3000])
    if m_camp:
        self_camp = int(m_camp.group(1))

    # Match each frame JSON
    print("Searching for frames via regex...")
    pattern = re.compile(r'\{"t":\s*[\d\.]+,.*?"n":\s*\d+\}')
    matches = list(pattern.finditer(text))
    print(f"Found {len(matches)} raw frame matches")

    valid_frames = []
    corrupt = 0
    for m in matches:
        chunk = m.group(0)
        try:
            fobj = json.loads(chunk)
            valid_frames.append(fobj)
        except Exception:
            corrupt += 1

    print(f"Valid frames: {len(valid_frames)}, Corrupted skipped: {corrupt}")

    if not valid_frames:
        print("Error: No valid frames recovered!")
        return False

    first_gt = valid_frames[0].get("gt", 0.0)
    last_gt = valid_frames[-1].get("gt", 0.0)
    duration = round(last_gt - first_gt, 1)
    if duration <= 0:
        duration = round(last_gt, 1)

    if valid_frames[0].get("self", {}).get("camp"):
        self_camp = valid_frames[0]["self"]["camp"]

    out_data = {
        "version": 1,
        "matchId": match_id,
        "recordedAt": rec_at,
        "selfCamp": self_camp,
        "duration": duration,
        "frames": valid_frames
    }

    bak_path = fpath + ".bak"
    if not os.path.exists(bak_path):
        try:
            os.replace(fpath, bak_path)
            print(f"Backed up original to {bak_path}")
        except Exception as e:
            print(f"Backup warning: {e}")

    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(out_data, f)

    print(f"Successfully rescued {fpath} with {len(valid_frames)} frames! Duration: {duration}s")
    return True

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else r"c:\Users\berni\Desktop\a35project\moba\m2\replays\20260926_203642_Edith.mreplay"
    rescue_file(target)
